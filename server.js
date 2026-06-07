"use strict"

try { require("dotenv").config() } catch {}
const express = require("express")
const { RBXModelParser, jsonReplacer } = require("./lib/RBXParser")
const { bufferToString } = require("./lib/ByteReader")

const app = express()
const PORT = process.env.PORT || 3000
const HOST = process.env.HOST || "127.0.0.1"
const ASSET_CACHE_TTL_MS = parseInt(process.env.ASSET_CACHE_TTL_MS || "300000", 10)
const assetCache = new Map()

// Convert RBXInstance tree to plain JSON
function instanceToJSON(instance) {
	const json = {
		ClassName: instance.getProperty("ClassName"),
		Name: instance.getProperty("Name"),
	}

	// Add all properties except internal ones
	const skipProps = new Set(["ClassName", "Name", "Parent", "Children"])
	for (const [key, prop] of Object.entries(instance.Properties)) {
		if (!skipProps.has(key)) {
			json[key] = serializeValue(prop.value, prop.type)
		}
	}

	// Add children
	if (instance.Children && instance.Children.length > 0) {
		json.Children = instance.Children.map(child => instanceToJSON(child))
	}

	return json
}

// Serialize complex values to human-readable JSON
function serializeValue(value, type) {
	if (value === null || value === undefined) {
		return null
	}

	// Instance references - just output the name
	if (type === "Instance" && value && typeof value === "object" && value.ClassName) {
		return {
			__type: "Instance",
			ClassName: value.getProperty("ClassName"),
			Name: value.getProperty("Name")
		}
	}

	// Arrays (Vector3, CFrame, Color3, etc.)
	if (Array.isArray(value)) {
		return value
	}

	// Objects (PhysicalProperties, Font, Faces, Axes, SecurityCapabilities, etc.)
	if (typeof value === "object" && value !== null && !(value instanceof Date)) {
		const result = {}
		for (const [k, v] of Object.entries(value)) {
			result[k] = serializeValue(v, type)
		}
		return result
	}

	// BigInt
	if (typeof value === "bigint") {
		return value.toString()
	}

	return value
}

// Roblox cookie - set via ROBLOX_COOKIE env var. Header cookies are opt-in.
function getCookie(req) {
	if (process.env.ALLOW_HEADER_COOKIE === "true" && req.headers["x-roblox-cookie"]) {
		return String(req.headers["x-roblox-cookie"]).trim()
	}

	return (process.env.ROBLOX_COOKIE || "").trim()
}

// Fetch asset from Roblox
async function fetchWithRetry(url, options, maxRetries = 3) {
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const res = await fetch(url, options)

		if (res.status === 429) {
			const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10)
			const delay = Math.min(retryAfter * 1000, 30000)
			console.log(`  Rate limited (429), waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})...`)
			await new Promise(r => setTimeout(r, delay))
			continue
		}

		return res
	}
	throw new Error("Rate limited too many times")
}

async function fetchAsset(assetId, cookie) {
	const cacheKey = `${assetId}:${cookie || "anonymous"}`
	const cached = assetCache.get(cacheKey)

	if (cached && Date.now() - cached.createdAt < ASSET_CACHE_TTL_MS) {
		console.log(`  Cache hit for asset ${assetId}`)
		return cached.value
	}

	const value = await fetchAssetUncached(assetId, cookie)
	assetCache.set(cacheKey, { createdAt: Date.now(), value })
	return value
}

async function fetchAssetUncached(assetId, cookie) {
	const hasCookie = !!cookie
	console.log(`  Cookie present: ${hasCookie}, length: ${cookie?.length || 0}`)

	const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

	// --- Try RoProxy first (no auth needed) ---
	try {
		console.log(`  Trying RoProxy...`)
		const roproxyUrl = `https://assetdelivery.roproxy.com/v2/asset/?id=${assetId}`
		const res = await fetchWithRetry(roproxyUrl, {
			headers: { "User-Agent": ua, "Accept": "application/json" }
		})
		if (res.ok) {
			const json = await res.json()
			if (json.locations && json.locations.length > 0) {
				console.log(`  RoProxy succeeded`)
				return await downloadFromLocations(json)
			}
		}
		console.log(`  RoProxy failed (${res.status}), falling back to cookie...`)
	} catch (e) {
		console.log(`  RoProxy error: ${e.message}, falling back to cookie...`)
	}

	// --- Fallback: direct Roblox with cookie ---
	if (!cookie) {
		throw new Error(`RoProxy failed and no cookie provided. Set ROBLOX_COOKIE in .env`)
	}

	const cookieHeader = `.ROBLOSECURITY=${cookie}`

	// Get CSRF token
	let csrfToken = ""
	try {
		const csrfRes = await fetchWithRetry("https://auth.roblox.com/v2/logout", {
			method: "POST",
			headers: { "User-Agent": ua, "Cookie": cookieHeader }
		})
		csrfToken = csrfRes.headers.get("x-csrf-token") || ""
		if (csrfToken) console.log(`  Got CSRF token`)
	} catch {}

	const headers = {
		"User-Agent": ua,
		"Accept": "application/json",
		"Roblox-Browser-Asset-Request": "true"
	}
	if (cookieHeader) headers["Cookie"] = cookieHeader
	if (csrfToken) headers["X-CSRF-TOKEN"] = csrfToken

	const url = `https://assetdelivery.roblox.com/v2/asset/?id=${assetId}`
	console.log(`  Fetching: ${url}`)

	const res = await fetchWithRetry(url, { headers })

	if (!res.ok) {
		if (res.status === 403) {
			const newCsrf = res.headers.get("x-csrf-token")
			if (newCsrf) {
				console.log(`  Got new CSRF, retrying...`)
				headers["X-CSRF-TOKEN"] = newCsrf
				const retryRes = await fetchWithRetry(url, { headers })
				if (!retryRes.ok) {
					const body = await retryRes.text().catch(() => "")
					throw new Error(`Asset fetch failed: ${retryRes.status} - ${body.substring(0, 200)}`)
				}
				return await processAssetResponse(retryRes)
			}
		}
		const body = await res.text().catch(() => "")
		throw new Error(`Asset fetch failed: ${res.status} - ${body.substring(0, 200)}`)
	}

	return await processAssetResponse(res)
}

async function downloadFromLocations(json) {
	const cdnUrl = json.locations[0].location
	console.log(`  Downloading from CDN...`)

	const cdnRes = await fetch(cdnUrl, {
		headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
	})

	if (!cdnRes.ok) {
		throw new Error(`CDN download failed: ${cdnRes.status}`)
	}

	return {
		buffer: Buffer.from(await cdnRes.arrayBuffer()),
		assetTypeId: json.assetTypeId
	}
}

async function processAssetResponse(res) {
	const json = await res.json()

	if (json.errors) {
		throw new Error(`Roblox API error: ${JSON.stringify(json.errors)}`)
	}

	if (!json.locations || json.locations.length === 0) {
		throw new Error(`No download locations for asset`)
	}

	const cdnUrl = json.locations[0].location
	console.log(`  Downloading from CDN...`)

	const cdnRes = await fetch(cdnUrl, {
		headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
	})

	if (!cdnRes.ok) {
		throw new Error(`CDN download failed: ${cdnRes.status}`)
	}

	return {
		buffer: Buffer.from(await cdnRes.arrayBuffer()),
		assetTypeId: json.assetTypeId
	}
}

// Routes

// GET /asset/:id - Fetch and parse a Roblox asset
app.get("/asset/:id", async (req, res) => {
	try {
		const assetId = parseInt(req.params.id, 10)

		if (!Number.isSafeInteger(assetId) || assetId <= 0) {
			return res.status(400).json({ error: "Invalid asset ID" })
		}

		const cookie = getCookie(req)
		console.log(`Fetching asset ${assetId}...`)
		const { buffer, assetTypeId } = await fetchAsset(assetId, cookie)

		console.log(`Parsing asset ${assetId} (type: ${assetTypeId})...`)
		const parser = RBXModelParser.parse(buffer)

		const instances = parser.result.map(inst => instanceToJSON(inst))

		const response = {
			assetId,
			assetTypeId,
			meta: parser.meta,
			instanceCount: countInstances(instances),
			instances
		}

		res.setHeader("Content-Type", "application/json")
		res.send(JSON.stringify(response, jsonReplacer))
	} catch (err) {
		console.error(`Error fetching asset ${req.params.id}:`, err.message)
		res.status(500).json({ error: err.message })
	}
})

// GET /asset/:id/tree - Flat tree view
app.get("/asset/:id/tree", async (req, res) => {
	try {
		const assetId = parseInt(req.params.id, 10)

		if (!Number.isSafeInteger(assetId) || assetId <= 0) {
			return res.status(400).json({ error: "Invalid asset ID" })
		}

		const cookie = getCookie(req)
		console.log(`Fetching asset ${assetId}...`)
		const { buffer, assetTypeId } = await fetchAsset(assetId, cookie)

		console.log(`Parsing asset ${assetId} (type: ${assetTypeId})...`)
		const parser = RBXModelParser.parse(buffer)

		const tree = []
		flattenInstances(parser.result, tree, "")

		const response = {
			assetId,
			assetTypeId,
			totalInstances: tree.length,
			instances: tree
		}

		res.setHeader("Content-Type", "application/json"); res.send(JSON.stringify(response, jsonReplacer))
	} catch (err) {
		console.error(`Error fetching asset ${req.params.id}:`, err.message)
		res.status(500).json({ error: err.message })
	}
})

// GET /asset/:id/search?class=ClassName - Search by class
app.get("/asset/:id/search", async (req, res) => {
	try {
		const assetId = parseInt(req.params.id, 10)
		const className = req.query.class
		const propName = req.query.prop
		const propValue = req.query.value

		if (!Number.isSafeInteger(assetId) || assetId <= 0) {
			return res.status(400).json({ error: "Invalid asset ID" })
		}

		const cookie = getCookie(req)
		console.log(`Fetching asset ${assetId}...`)
		const { buffer, assetTypeId } = await fetchAsset(assetId, cookie)

		console.log(`Parsing asset ${assetId} (type: ${assetTypeId})...`)
		const parser = RBXModelParser.parse(buffer)

		let results = []

		function searchInstances(instances, path) {
			for (const inst of instances) {
				const currentPath = path ? `${path}/${inst.getProperty("Name")}` : inst.getProperty("Name")
				const instClassName = inst.getProperty("ClassName")

				let matches = true
				if (className && instClassName !== className) matches = false
				if (propName && inst.getProperty(propName) === undefined) matches = false
				if (propValue && String(inst.getProperty(propName)) !== propValue) matches = false

				if (matches && (className || propName)) {
					results.push({
						path: currentPath,
						...instanceToJSON(inst)
					})
				}

				if (inst.Children && inst.Children.length > 0) {
					searchInstances(inst.Children, currentPath)
				}
			}
		}

		searchInstances(parser.result, "")

		const response = {
			assetId,
			assetTypeId,
			query: { class: className, prop: propName, value: propValue },
			resultCount: results.length,
			results
		}

		res.setHeader("Content-Type", "application/json"); res.send(JSON.stringify(response, jsonReplacer))
	} catch (err) {
		console.error(`Error fetching asset ${req.params.id}:`, err.message)
		res.status(500).json({ error: err.message })
	}
})

// GET /asset/:id/class/:className - Get all instances of a class
app.get("/asset/:id/class/:className", async (req, res) => {
	try {
		const assetId = parseInt(req.params.id, 10)
		const className = req.params.className

		if (!Number.isSafeInteger(assetId) || assetId <= 0) {
			return res.status(400).json({ error: "Invalid asset ID" })
		}

		const cookie = getCookie(req)
		console.log(`Fetching asset ${assetId}...`)
		const { buffer, assetTypeId } = await fetchAsset(assetId, cookie)

		console.log(`Parsing asset ${assetId} (type: ${assetTypeId})...`)
		const parser = RBXModelParser.parse(buffer)

		const results = []

		function findByClass(instances, path) {
			for (const inst of instances) {
				const currentPath = path ? `${path}/${inst.getProperty("Name")}` : inst.getProperty("Name")

				if (inst.getProperty("ClassName") === className) {
					results.push({
						path: currentPath,
						...instanceToJSON(inst)
					})
				}

				if (inst.Children && inst.Children.length > 0) {
					findByClass(inst.Children, currentPath)
				}
			}
		}

		findByClass(parser.result, "")

		const response = {
			assetId,
			assetTypeId,
			className,
			resultCount: results.length,
			results
		}

		res.setHeader("Content-Type", "application/json"); res.send(JSON.stringify(response, jsonReplacer))
	} catch (err) {
		console.error(`Error fetching asset ${req.params.id}:`, err.message)
		res.status(500).json({ error: err.message })
	}
})

// GET /asset/:id/raw - Return raw asset buffer as base64 (for source viewer)
app.get("/asset/:id/raw", async (req, res) => {
	try {
		const assetId = parseInt(req.params.id, 10)
		if (!Number.isSafeInteger(assetId) || assetId <= 0) return res.status(400).json({ error: "Invalid asset ID" })
		const cookie = getCookie(req)
		console.log(`Fetching raw asset ${assetId}...`)
		const { buffer } = await fetchAsset(assetId, cookie)
		const isXML = buffer.length > 7 && buffer[0] === 0x3C && buffer[1] === 0x72
		let content, contentType
		if (isXML) {
			content = bufferToString(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
			contentType = "text/plain; charset=utf-8"
		} else {
			content = buffer.toString("base64")
			contentType = "text/plain; charset=utf-8"
		}
		res.setHeader("Content-Type", contentType)
		res.send(content)
	} catch (err) {
		console.error(`Error fetching raw asset ${req.params.id}:`, err.message)
		res.status(500).json({ error: err.message })
	}
})

// GET /health - Health check
app.get("/health", (req, res) => {
	const cookie = process.env.ROBLOX_COOKIE
	res.json({
		status: "ok",
		cookieLoaded: !!cookie,
		headerCookieEnabled: process.env.ALLOW_HEADER_COOKIE === "true",
		cacheEntries: assetCache.size,
		timestamp: new Date().toISOString()
	})
})

// GET / - Web UI
app.get("/", (req, res) => {
	res.setHeader("Content-Type", "text/html")
	res.send(renderHomePage())
})

// Roblox class icon asset IDs (from Roblox Studio's ClassImages.png mapping)
const CLASS_ICON_ASSETS = {
Part: 7368549141, MeshPart: 7368549141, WedgePart: 7368549141,
CornerWedgePart: 7368549141, Seat: 4716957040, VehicleSeat: 4716957040,
TrussPart: 7368549141, UnionOperation: 7368549141,
Model: 18402365961, Folder: 413364594,
Script: 4998267428, LocalScript: 120549633847891, ModuleScript: 72574623675660,
Decal: 4716862168, Texture: 1137331065,
Sound: 4717029670, SoundService: 4716950152,
PointLight: 4717042968, SpotLight: 4717042968, SurfaceLight: 4717042968,
Fire: 4717042968, Smoke: 4717042968, ParticleEmitter: 4717042968,
Beam: 4717042968, Trail: 4717042968,
SurfaceGui: 4716944807, BillboardGui: 4716944807, ScreenGui: 4716944807,
Frame: 4716944807, TextLabel: 4716944807, TextButton: 4716944807,
ImageLabel: 4716944807, ImageButton: 4716944807, ScrollingFrame: 4716944807,
TextBox: 4716944807, TextButton: 4716944807,
CanvasGroup: 4716944807, UIListLayout: 4716944807, UIGridLayout: 4716944807,
UIPageLayout: 4716944807, UIPadding: 4716944807, UIStroke: 4716944807,
UICorner: 4716944807, UIGradient: 4716944807, UISizeConstraint: 4716944807,
UIAspectRatioConstraint: 4716944807, UIScale: 4716944807,
Weld: 4717052851, WeldConstraint: 4717052851, Motor6D: 5810663725,
Snap: 4717052851, ManualWeld: 4717052851,
Attachment: 80898777249401,
BlockMesh: 4716998146, CylinderMesh: 4716998146, SpecialMesh: 4716998146,
Force: 4717042968, VectorForce: 4717042968,
BodyPosition: 4717042968, BodyGyro: 4717042968, BodyVelocity: 4717042968,
BodyForce: 4717042968, BodyThrust: 4717042968, BodyAngularVelocity: 4717042968,
AlignPosition: 4717042968, AlignOrientation: 4717042968,
LinearVelocity: 4717042968, AngularVelocity: 4717042968,
HingeConstraint: 4716868593, BallSocketConstraint: 4717007158,
PrismaticConstraint: 4717053331, RopeConstraint: 4717008397,
RodConstraint: 4717031013, SpringConstraint: 4717058653,
TorsionSpringConstraint: 4717058653, VectorForce: 4717042968,
Humanoid: 16140823621, HumanoidDescription: 4717013513,
Animator: 4716834482, Animation: 4716833804, AnimationController: 4716834482,
AnimationTrack: 4716833804,
ClickDetector: 4716981709, DragDetector: 4716981709,
ProximityPrompt: 17847720170,
Terrain: 4716998146, SpawnLocation: 6400507398,
Camera: 4716868593, Player: 4716868593, Team: 4716890581,
Workspace: 95456161529373, Players: 116765674595407,
Lighting: 134167243059323, ReplicatedStorage: 4716891544,
ReplicatedFirst: 4717026633, ServerStorage: 4717001202,
StarterGui: 5428265778, StarterPack: 64941472,
StarterPlayer: 413371732, ServerScriptService: 4717001202,
ServerScriptService: 4717001202, StarterPlayerScripts: 4717051872,
DataStoreService: 4717036895, HttpService: 5276072647,
PathfindingService: 4717009535, TextChatService: 4716951386,
TeleportService: 4716862646, GuiService: 4716944807,
UserInputService: 4716944807, ContextActionService: 4716944807,
RunService: 4716944807, TweenService: 4716944807,
CollectionService: 4716944807, Debris: 4716944807,
SoundGroup: 4717029670, Atmosphere: 15427872518,
Sky: 4716945938, BloomEffect: 4717059621, BlurEffect: 4717059621,
ColorCorrectionEffect: 140014181975417, DepthOfFieldEffect: 4717059621,
SunRaysEffect: 4717059621, Clouds: 4716994726,
SurfaceAppearance: 4717036429,
Accessory: 4716833804, Hat: 4716833804, Shirt: 4716833804,
Pants: 4716833804, ShirtGraphic: 4716833804,
ShirtGraphic: 4716833804, CharacterMesh: 4716833804,
PackageLink: 4716833804, DataStore: 4717036895,
ModuleScript: 72574623675660,
RemoteEvent: 4717009535, RemoteFunction: 4717009535,
BindableEvent: 4717009535, BindableFunction: 4717009535,
ValueBase: 4716944807, IntValue: 4716944807, StringValue: 4716944807,
BoolValue: 4716944807, ObjectValue: 4716944807, NumberValue: 4716944807,
StringValue: 4716944807, RayValue: 4716944807, BrickColorValue: 4716944807,
Color3Value: 4716944807, Vector3Value: 4716944807,
CFrameValue: 4716944807, Vector2Value: 4716944807,
UIDragDetector: 4716981709, LayerCollector: 4716944807,
GuiBase: 4716944807, GuiObject: 4716944807,
Plugin: 4717001202
};

let iconUrlCache = {};

async function fetchClassIcons() {
  const ids = [...new Set(Object.values(CLASS_ICON_ASSETS))];
  const batchSize = 20;
  const results = {};
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    try {
      const idStr = batch.join(',');
      const r = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${idStr}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.data) {
        for (const item of j.data) {
          if (item.state === 'Completed' && item.imageUrl) {
            results[item.targetId] = item.imageUrl;
          }
        }
      }
    } catch (e) { /* skip failed batches */ }
  }
  // Map class names to URLs
  const classUrls = {};
  for (const [cls, assetId] of Object.entries(CLASS_ICON_ASSETS)) {
    if (results[assetId]) classUrls[cls] = results[assetId];
  }
  iconUrlCache = classUrls;
  console.log(`Fetched ${Object.keys(classUrls).length} class icon URLs`);
}

// Fetch icons at startup (non-blocking)
fetchClassIcons().catch(() => {});
// Refresh every 30 minutes
setInterval(() => fetchClassIcons().catch(() => {}), 30 * 60 * 1000);

function renderHomePage() {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="Fetch and inspect Roblox RBXM assets with a Studio-style explorer, properties panel, and script source viewer.">
<title>rbxasset-fetch</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');
:root{color-scheme:dark;--bg:#090a0b;--surface:#111214;--surface2:#181a1d;--surface3:#1f2226;--border:#262a2f;--border2:#2e3339;--text:#e8eaed;--text2:#a0a4a8;--text3:#6b7076;--accent:#e2b340;--accent2:#3ecf8e;--red:#ef4444;--green:#22c55e;--mono:'Geist Mono','SF Mono','Fira Code',monospace;--sans:'Inter',system-ui,-apple-system,sans-serif;--radius:8px;--radius-sm:5px}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font-family:var(--sans);overflow:hidden;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.skip{position:absolute;left:-999px;top:1rem;background:var(--accent);color:#000;padding:.5rem .8rem;border-radius:var(--radius-sm);z-index:10;font-weight:600;font-size:.8rem}.skip:focus{left:1rem}
.shell{height:100%;display:grid;grid-template-rows:auto 1fr auto}

.top{display:grid;grid-template-columns:auto 1fr auto;gap:1.25rem;align-items:center;padding:.85rem 1.5rem;border-bottom:1px solid var(--border);background:var(--surface)}
.brand{display:flex;align-items:center;gap:.6rem;min-width:0}
.brand-icon{width:28px;height:28px;border-radius:6px;background:linear-gradient(135deg,var(--accent),#d4940a);display:grid;place-items:center;font-size:14px;font-weight:700;color:#000;flex-shrink:0}
.brand h1{margin:0;font-size:.95rem;font-weight:700;letter-spacing:-.02em;color:var(--text)}
.brand span{color:var(--text3);font-size:.75rem;font-weight:500;white-space:nowrap;letter-spacing:.01em}

.fetch{display:flex;gap:.5rem;align-items:stretch}
.field{width:100%;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:var(--radius-sm);padding:.55rem .85rem;font:500 .85rem var(--mono);outline:none;transition:border-color .2s,box-shadow .2s}
.field:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(226,179,64,.1)}
.field::placeholder{color:var(--text3)}
.btn{border:0;border-radius:var(--radius-sm);background:var(--accent);color:#000;font:600 .85rem var(--sans);padding:.55rem 1.1rem;cursor:pointer;transition:all .15s ease;white-space:nowrap;letter-spacing:-.01em}
.btn:hover{background:#f0c050;transform:translateY(-1px);box-shadow:0 4px 12px rgba(226,179,64,.2)}
.btn:active{transform:translateY(0) scale(.98)}
.btn:disabled{background:var(--surface3);color:var(--text3);cursor:not-allowed;transform:none;box-shadow:none}

.health{justify-self:end;display:flex;align-items:center;gap:.4rem;color:var(--text3);font:500 .75rem var(--mono);font-variant-numeric:tabular-nums}
.dot{width:.45rem;height:.45rem;border-radius:50%;background:var(--text3);transition:background .3s}
.dot.ok{background:var(--green)}
.dot.bad{background:var(--red)}

.status{display:none;margin:.75rem 1.5rem 0;padding:.6rem .85rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);font-size:.82rem;font-weight:500}
.status.show{display:flex;align-items:center;gap:.5rem}
.status.error{border-color:rgba(239,68,68,.3);color:var(--red);background:rgba(239,68,68,.06)}
.status.success{border-color:rgba(34,197,94,.3);color:var(--green);background:rgba(34,197,94,.06)}
.status.loading{color:var(--accent)}

main{min-height:0;display:grid;grid-template-columns:minmax(16rem,26rem) 1fr;gap:0;padding:.75rem 1.5rem 0}
.pane{min-height:0;background:var(--surface);border:1px solid var(--border);overflow:hidden}
.side{display:grid;grid-template-rows:1fr 1fr;border-radius:var(--radius) 0 0 var(--radius);border-right:0}
.work{display:grid;grid-template-rows:1fr;border-radius:0 var(--radius) var(--radius) 0}

.studio-panel{min-height:0;display:grid;grid-template-rows:auto 1fr;border-bottom:1px solid var(--border)}
.studio-panel:last-child{border-bottom:0}
.studio-title{display:flex;align-items:center;justify-content:space-between;padding:.6rem .8rem;border-bottom:1px solid var(--border);background:var(--surface2);font-size:.72rem;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.06em}
.studio-title span{color:var(--text3);font:500 .68rem var(--mono)}
.tools{display:flex;gap:.5rem;padding:.5rem .65rem;border-bottom:1px solid var(--border)}
.tools .field{font-size:.78rem;padding:.45rem .6rem;border-radius:var(--radius-sm)}
.panel{min-height:0;display:none;overflow:hidden}
.panel.active{display:block}

.tree{height:100%;overflow:auto;padding:.45rem;font:500 .78rem/1.5 var(--mono)}
.node{margin-left:.75rem}
.node.root{margin-left:0}
.row{display:flex;align-items:center;gap:.35rem;min-width:max-content;padding:.2rem .35rem;border-radius:var(--radius-sm);cursor:pointer;transition:background .12s}
.row:hover{background:var(--surface3)}
.row.selected{background:rgba(226,179,64,.1);box-shadow:inset 2px 0 0 var(--accent)}
.tw{width:.8rem;color:var(--text3);font-size:.65rem;transition:color .12s}
.row:hover .tw{color:var(--text2)}
.badge{display:inline-flex;align-items:center;justify-content:center;width:1rem;height:1rem;border-radius:3px;flex-shrink:0;overflow:hidden}
.badge img{width:16px;height:16px;image-rendering:auto}
.badge-fallback{background:var(--surface3);color:var(--text);font-size:.55rem;font-weight:700;letter-spacing:0}
.class{color:var(--accent2);font-weight:600}
.name{color:var(--text)}
.count{color:var(--text3);font-size:.65rem;margin-left:.25rem}

.props{height:100%;overflow:auto;padding:.75rem}
.props h2{margin:0 0 .6rem;font-size:.85rem;font-weight:600;color:var(--text);letter-spacing:-.01em}
.prop{display:grid;grid-template-columns:minmax(5rem,35%) 1fr;gap:.5rem;padding:.35rem 0;border-bottom:1px solid var(--border);font-size:.72rem}
.prop:last-child{border-bottom:0}
.key{color:var(--accent);font:500 .72rem var(--mono)}
.val{color:var(--text2);word-break:break-word;font:400 .72rem var(--mono)}

.empty{height:100%;display:grid;place-items:center;text-align:center;color:var(--text3);padding:2rem}
.empty strong{display:block;color:var(--text2);font-size:.95rem;font-weight:600;margin-bottom:.3rem;letter-spacing:-.01em}
.empty span{font-size:.8rem;line-height:1.5}

.source{height:100%;grid-template-rows:auto 1fr}
.source.panel.active{display:grid}
.sourcebar{display:flex;gap:.5rem;align-items:center;padding:.6rem .85rem;border-bottom:1px solid var(--border);background:var(--surface2)}
.sourcebar .field{max-width:16rem;font-size:.78rem;padding:.4rem .6rem}
.script-name{color:var(--text);font:600 .78rem var(--mono);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sourcebar .mini{border:1px solid var(--border);background:var(--surface);color:var(--text2);border-radius:var(--radius-sm);padding:.35rem .65rem;font:500 .72rem var(--sans);cursor:pointer;transition:all .15s}
.sourcebar .mini:hover{background:var(--surface3);border-color:var(--text3);color:var(--text)}
.codewrap{min-height:0;display:grid;grid-template-columns:auto 1fr;overflow:hidden}
.lines{overflow:hidden;padding:.75rem .4rem;text-align:right;color:var(--text3);background:var(--surface2);font:.72rem/1.65 var(--mono);user-select:none;border-right:1px solid var(--border)}
.lines div{padding:0 .5rem}
.code{overflow:auto;margin:0;padding:.75rem;font:.72rem/1.65 var(--mono);white-space:pre;color:var(--text2);tab-size:2}
.lua-key{color:var(--accent)}
.lua-string{color:var(--accent2)}
.lua-comment{color:var(--text3);font-style:italic}
.lua-number{color:#7dd3fc}
mark{background:rgba(226,179,64,.2);color:var(--text);border-radius:2px;padding:0 1px}

.foot{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 1.5rem;color:var(--text3);font:.7rem var(--mono);border-top:1px solid var(--border);background:var(--surface)}

@media(max-width:860px){
  body{overflow:auto}
  .shell{min-height:100%;height:auto}
  .top{grid-template-columns:1fr;gap:.75rem;padding:.75rem 1rem}
  .health{justify-self:start}
  .fetch{width:100%}
  main{grid-template-columns:1fr;grid-auto-rows:minmax(20rem,1fr);padding:.75rem 1rem}
  .side{border-radius:var(--radius);border:1px solid var(--border);grid-template-rows:minmax(16rem,40%) minmax(12rem,auto)}
  .work{border-radius:var(--radius);border:1px solid var(--border);min-height:24rem}
}
</style>
</head>
<body>
<a class="skip" href="#workbench">Skip to workbench</a>
<div class="shell">
<header class="top">
<div class="brand"><div class="brand-icon">R</div><h1>rbxasset-fetch</h1><span>v1.0</span></div>
<form class="fetch" id="fetchForm"><input class="field" id="assetId" inputmode="numeric" autocomplete="off" placeholder="Enter Roblox asset ID\u2026"><button class="btn" id="fetchBtn">Fetch</button></form>
<div class="health" id="health"><span class="dot"></span>checking</div>
</header>
<div class="status" id="status"></div>
<main id="workbench">
<aside class="pane side">
<section class="studio-panel">
<div class="studio-title">Explorer <span id="explorerCount">0</span></div>
<div class="tools"><input class="field" id="filter" placeholder="Filter instances\u2026"></div>
<div class="tree" id="treePanel"><div class="empty"><div><strong>No asset loaded</strong><span>Enter an asset ID above to inspect its instance hierarchy.</span></div></div></div>
</section>
<section class="studio-panel">
<div class="studio-title">Properties <span id="propsClass">none</span></div>
<div class="props" id="propsPanel"><div class="empty"><div><strong>No selection</strong><span>Select an instance from the Explorer to view its properties.</span></div></div></div>
</section>
</aside>
<section class="pane work">
<section class="panel active source" id="sourcePanel"><div class="sourcebar"><span class="script-name" id="scriptName">No script selected</span><input class="field" id="sourceSearch" placeholder="Search source\u2026"><button class="mini" id="downloadBtn">Download</button><span class="health" id="sourceInfo"></span></div><div class="codewrap"><div class="lines" id="lines"></div><pre class="code" id="code"></pre></div></section>
</section>
</main>
<footer class="foot"><span id="summary">Idle</span><span>Local workbench</span></footer>
</div>
<script>
"use strict"
const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s))
const iconUrls=${JSON.stringify(iconUrlCache)};
function getIconUrl(name){return iconUrls[name]||''}
let data=null,currentSource="",selected=null,selectedScript=null

function esc(v){const d=document.createElement("div");d.textContent=String(v??"");return d.innerHTML}
function setStatus(type,msg){const el=$("#status");el.className="status show "+type;el.textContent=msg}
function clearStatus(){const el=$("#status");el.className="status";el.textContent=""}
async function checkHealth(){try{const r=await fetch("/health");const j=await r.json();$("#health").innerHTML='<span class="dot ok"></span>ready '+(j.cookieLoaded?"with cookie":"via public fetch")}catch{$("#health").innerHTML='<span class="dot bad"></span>offline'}}
$("#fetchForm").addEventListener("submit",e=>{e.preventDefault();loadAsset()})
$("#filter").addEventListener("input",filterTree);$("#sourceSearch").addEventListener("input",searchSource);$("#downloadBtn").addEventListener("click",downloadSource)

async function loadAsset(){const id=$("#assetId").value.trim();if(!/^\\d+$/.test(id)){setStatus("error","Enter a numeric Roblox asset ID.");return}const btn=$("#fetchBtn");btn.disabled=true;setStatus("loading","Fetching and parsing asset "+id+"...");try{const r=await fetch("/asset/"+id);const j=await r.json();if(!r.ok||j.error)throw new Error(j.error||"Request failed");data=j;setStatus("success","Loaded "+j.instanceCount+" instances from asset "+j.assetId+".");$("#summary").textContent="Asset "+j.assetId+" | "+j.instanceCount+" instances | type "+(j.assetTypeId||"unknown");renderTree(j.instances);renderEmptySource()}catch(e){setStatus("error",e.message)}finally{btn.disabled=false}}
function isScript(inst){return inst&&["Script","LocalScript","ModuleScript"].includes(inst.ClassName)}
function renderTree(instances){const root=$("#treePanel");root.innerHTML="";const nodes=[];function walk(list,parent,depth){list.forEach(inst=>{const kids=inst.Children||[];const node=document.createElement("div");node.className="node "+(depth?"":"root");node.dataset.text=((inst.ClassName||"")+" "+(inst.Name||"")).toLowerCase();const row=document.createElement("div");row.className="row";row.tabIndex=0;row.title=isScript(inst)?"Double-click to open Source":"";const icoUrl=getIconUrl(inst.ClassName);row.innerHTML='<span class="tw">'+(kids.length?"+":"")+'</span>'+(icoUrl?'<span class="badge"><img src="'+icoUrl+'" alt="" width="16" height="16" loading="lazy"></span>':'<span class="badge badge-fallback">'+esc((inst.ClassName||'?')[0])+'</span>')+'<span class="class">'+esc(inst.ClassName)+'</span><span class="name">'+esc(inst.Name||"")+'</span>'+(kids.length?'<span class="count">'+kids.length+'</span>':"");const childBox=document.createElement("div");childBox.hidden=true;function open(v){childBox.hidden=!v;row.querySelector(".tw").textContent=kids.length?(v?"-":"+"):""}row.addEventListener("click",()=>{open(childBox.hidden);selectInstance(inst,row)});row.addEventListener("dblclick",e=>{e.stopPropagation();selectInstance(inst,row);if(isScript(inst))openScriptSource(inst)});row.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();row.click()}else if(e.key==="F4"&&isScript(inst)){e.preventDefault();selectInstance(inst,row);openScriptSource(inst)}});nodes.push({node,row,inst,open,depth});node.append(row,childBox);parent.append(node);walk(kids,childBox,depth+1)})}walk(instances,root,0);root._nodes=nodes;$("#explorerCount").textContent=nodes.length}
function selectInstance(inst,row){selected=inst;$$(".row.selected").forEach(e=>e.classList.remove("selected"));row?.classList.add("selected");$("#propsClass").textContent=inst.ClassName||"Instance";const props=$("#propsPanel");let html="<h2>"+esc(inst.ClassName)+" "+esc(inst.Name||"")+"</h2>";Object.entries(inst).forEach(([k,v])=>{if(["ClassName","Name","Children"].includes(k))return;const display=k==="Source"&&typeof v==="string"?(v.split("\\n").length+" lines"):typeof v==="object"?JSON.stringify(v):v;html+='<div class="prop"><div class="key">'+esc(k)+'</div><div class="val">'+esc(display)+'</div></div>'});html+='<div class="prop"><div class="key">Children</div><div class="val">'+((inst.Children||[]).length)+'</div></div>';props.innerHTML=html}
function filterTree(){const q=$("#filter").value.toLowerCase();($("#treePanel")._nodes||[]).forEach(n=>{const show=!q||n.node.dataset.text.includes(q);n.node.style.display=show?"":"none";if(show&&q){let p=n.node.parentElement;while(p&&p.id!=="treePanel"){if(p.hidden)p.hidden=false;p=p.parentElement}}})}
function renderEmptySource(){selectedScript=null;currentSource="";$("#scriptName").textContent="No script selected";$("#code").textContent="Double-click a Script, LocalScript, or ModuleScript in Explorer to view its Source property.";$("#lines").innerHTML="<div>1</div>";$("#sourceInfo").textContent="";$("#sourceSearch").value=""}
function openScriptSource(inst){selectedScript=inst;currentSource=typeof inst.Source==="string"?inst.Source:"";$("#scriptName").textContent=(inst.ClassName||"Script")+" / "+(inst.Name||"(unnamed)");renderSourceText(currentSource)}
function renderSourceText(text){$("#code").innerHTML=highlightLua(text||"-- Source property is empty or unavailable.",$("#sourceSearch").value);const count=(text||"").split("\\n").length;$("#lines").innerHTML=Array.from({length:Math.max(1,count)},(_,i)=>"<div>"+(i+1)+"</div>").join("");$("#sourceInfo").textContent=(text?count:0)+" lines";$("#code").onscroll=()=>{$("#lines").scrollTop=$("#code").scrollTop}}
function highlightLua(s,query=""){const token=/--[^\\n]*|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\b\\d+\\.?\\d*\\b|\\b(?:and|break|do|else|elseif|end|false|for|function|if|in|local|nil|not|or|repeat|return|then|true|until|while|continue|export|type|typeof|task|script|game|workspace|require)\\b/g;let out="",last=0,m;while((m=token.exec(s))){out+=markMatches(s.slice(last,m.index),query);const t=m[0];let cls=/^--/.test(t)?"lua-comment":/^["']/.test(t)?"lua-string":/^\\d/.test(t)?"lua-number":"lua-key";out+='<span class="'+cls+'">'+markMatches(t,query)+"</span>";last=token.lastIndex}return out+markMatches(s.slice(last),query)}
function markMatches(text,query){const safeText=esc(text);if(!query)return safeText;const safe=query.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g,"\\\\$&");return safeText.replace(new RegExp("("+safe+")","gi"),"<mark>$1</mark>")}
function searchSource(){const q=$("#sourceSearch").value;const safe=q.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g,"\\\\$&");const matches=q?currentSource.match(new RegExp(safe,"gi"))||[]:[];$("#sourceInfo").textContent=q?matches.length+" matches":(currentSource?currentSource.split("\\n").length:0)+" lines";$("#code").innerHTML=highlightLua(currentSource,q)}
function downloadSource(){const text=currentSource||"";const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type:"text/plain"}));a.download=((selectedScript?.Name)||"script")+".lua";a.click();URL.revokeObjectURL(a.href)}
checkHealth()
</script>
</body>
</html>`
}

// GET / - Web UI
app.get("/legacy", (req, res) => {
	res.setHeader("Content-Type", "text/html")
	res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RBXM Asset Viewer</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;height:100vh;display:flex;flex-direction:column;overflow:hidden}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:12px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0}
.header h1{font-size:16px;font-weight:600;color:#f0f6fc}
.header span{color:#8b949e;font-size:12px}
.input-row{display:flex;gap:8px}
input[type=text]{flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:7px 12px;color:#f0f6fc;font-size:13px;outline:none;min-width:0}
input:focus{border-color:#58a6ff}
input::placeholder{color:#484f58}
button{background:#238636;border:none;border-radius:6px;padding:7px 16px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
button:hover{background:#2ea043}
button:disabled{background:#21262d;color:#484f58;cursor:not-allowed}
.main{display:flex;flex:1;overflow:hidden}
.sidebar{width:420px;min-width:320px;border-right:1px solid #30363d;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0}
.sidebar-header{padding:10px 14px;border-bottom:1px solid #21262d;display:flex;gap:6px;flex-shrink:0}
.sidebar-header input{font-size:12px;padding:5px 10px}
.tab-bar{display:flex;border-bottom:1px solid #30363d;flex-shrink:0}
.tab{padding:8px 16px;font-size:12px;font-weight:500;color:#8b949e;cursor:pointer;border-bottom:2px solid transparent;user-select:none}
.tab:hover{color:#c9d1d9}
.tab.active{color:#f0f6fc;border-bottom-color:#58a6ff}
.panel{flex:1;overflow:auto;display:none}
.panel.active{display:block}
.explorer{font-family:'Cascadia Code','Fira Code',monospace;font-size:12px;line-height:1.5;overflow:auto;flex:1}
.ex-node{padding-left:16px}
.ex-node.root{padding-left:0}
.ex-header{display:flex;align-items:center;gap:4px;padding:2px 6px;border-radius:3px;cursor:pointer;white-space:nowrap;outline:none}
.ex-header:hover{background:#161b22}
.ex-header.selected{background:#1f3a5f}
.ex-header:focus-visible{outline:1px solid #58a6ff;outline-offset:-1px}
.ex-toggle{color:#484f58;width:12px;text-align:center;flex-shrink:0;font-size:10px}
.ex-icon{width:14px;height:14px;border-radius:2px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex-shrink:0;color:#fff}
.ex-class{color:#7ee787;font-weight:600}
.ex-name{color:#c9d1d9}
.ex-count{color:#484f58;font-size:10px;margin-left:4px}
.ex-children{display:none}
.ex-children.open{display:block}
.props-panel{padding:10px 14px;font-size:12px}
.props-panel h3{font-size:13px;color:#f0f6fc;margin-bottom:8px;font-weight:600}
.prop-row{display:flex;padding:3px 0;border-bottom:1px solid #161b22}
.prop-key{color:#d2a8ff;min-width:130px;flex-shrink:0}
.prop-val{color:#a5d6ff;word-break:break-all}
.prop-val.obj{color:#8b949e;font-style:italic}
.viewer-3d{position:relative;background:#0d1117;width:100%;height:100%}
.viewer-3d canvas{display:block;width:100%!important;height:100%!important;cursor:grab}
.viewer-3d canvas:active{cursor:grabbing}
.viewer-overlay{position:absolute;top:10px;left:10px;font-size:11px;color:#8b949e;pointer-events:none}
.viewer-controls{position:absolute;top:10px;right:10px;display:flex;flex-direction:column;gap:4px;pointer-events:auto}
.viewer-controls button{background:#161b22;border:1px solid #30363d;border-radius:4px;padding:4px 8px;color:#c9d1d9;font-size:11px;cursor:pointer;font-weight:400;white-space:nowrap}
.viewer-controls button:hover{background:#1c2333;border-color:#484f58}
.viewer-controls button.active{background:#1f3a5f;border-color:#58a6ff;color:#f0f6fc}
.viewer-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#484f58;font-size:14px}
.source-view{display:flex;flex-direction:column;height:100%}
.source-toolbar{display:flex;gap:6px;align-items:center;padding:8px 14px;border-bottom:1px solid #21262d;flex-shrink:0}
.source-toolbar input{font-size:12px;padding:4px 10px;width:200px}
.source-toolbar button{padding:4px 10px;font-size:11px}
.source-container{display:flex;flex:1;overflow:hidden}
.source-lines{padding:14px 0;text-align:right;color:#484f58;font-family:'Cascadia Code','Fira Code',monospace;font-size:11px;line-height:1.6;user-select:none;border-right:1px solid #21262d;overflow:hidden;min-width:40px;background:#161b22}
.source-lines div{padding:0 8px}
.source-pre{flex:1;overflow:auto;font-family:'Cascadia Code','Fira Code',monospace;font-size:11px;line-height:1.6;white-space:pre;tab-size:2}
.source-pre code{display:block;padding:14px}
.status{padding:8px 14px;border-radius:6px;margin:10px 14px;font-size:12px;display:none;flex-shrink:0}
.status.loading{display:block;background:#1c2333;border:1px solid #1f6feb;color:#58a6ff}
.status.error{display:block;background:#3d1f20;border:1px solid #f85149;color:#f85149}
.status.success{display:block;background:#1c2d1f;border:1px solid #238636;color:#3fb950}
.info-bar{display:flex;gap:12px;padding:6px 14px;border-top:1px solid #21262d;font-size:11px;color:#484f58;flex-shrink:0}
.json-key{color:#d2a8ff}.json-string{color:#a5d6ff}.json-number{color:#79c0ff}.json-bool{color:#ff7b72}.json-null{color:#8b949e}
</style>
</head>
<body>
<div class="header">
<h1>RBXM Asset Viewer</h1>
<span>Roblox asset parser &amp; explorer</span>
<div class="input-row" style="flex:1;max-width:500px;margin-left:20px">
<input type="text" id="assetId" placeholder="Asset ID (e.g. 6880366374)" onkeydown="if(event.key==='Enter')loadAsset()">
<button id="fetchBtn" onclick="loadAsset()">Fetch</button>
</div>
</div>
<div class="status" id="status"></div>
<div class="main" id="mainArea" style="display:none">
<div class="sidebar">
<div class="tab-bar">
<div class="tab active" data-tab="explorer" onclick="switchTab('explorer')">Explorer</div>
<div class="tab" data-tab="props" onclick="switchTab('props')">Properties</div>
</div>
<div class="sidebar-header">
<input type="text" id="searchInput" placeholder="Filter instances..." oninput="filterExplorer()">
</div>
<div class="panel active" id="explorerPanel" style="display:flex;flex-direction:column">
<div class="explorer" id="explorerTree" tabindex="0"></div>
</div>
<div class="panel" id="propsPanel">
<div class="props-panel" id="propsContent">
<div style="color:#484f58;padding:20px;text-align:center">Select an instance to view its properties</div>
</div>
</div>
</div>
<div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
<div class="tab-bar">
<div class="tab active" data-tab="3d" onclick="switchMainTab('3d')">3D View</div>
<div class="tab" data-tab="source" onclick="switchMainTab('source')">Source</div>
</div>
<div class="panel active" id="viewer3dPanel">
<div class="viewer-3d" id="viewer3d">
<div class="viewer-empty" id="viewerEmpty">Load an asset to view it in 3D</div>
</div>
<div class="viewer-overlay" id="viewerInfo"></div>
<div class="viewer-controls" id="viewerControls" style="display:none">
<button onclick="toggleWireframe()" id="btnWireframe">Wireframe</button>
<button onclick="toggleGrid()" id="btnGrid">Grid</button>
<button onclick="frameAll()">Frame All</button>
</div>
</div>
<div class="panel" id="sourcePanel">
<div class="source-view">
<div class="source-toolbar">
<input type="text" id="sourceSearch" placeholder="Search source..." oninput="searchSource()">
<button onclick="downloadSource()">Download</button>
<span id="sourceSearchInfo" style="color:#484f58;font-size:11px"></span>
</div>
<div class="source-container">
<div class="source-lines" id="sourceLines"></div>
<div class="source-pre" id="sourceScroll"><code id="sourceContent"></code></div>
</div>
</div>
</div>
</div>
</div>
<div class="info-bar" id="infoBar"></div>
<script>
"use strict"

let data = null, selectedNode = null
let scene, camera, renderer, meshGroup, orbitState
let gridHelper, showGrid = true, showWireframe = false
let allMeshes = []

const CLASS_COLORS = {Part:"39c4cc",MeshPart:"39c4cc",UnionOperation:"8c8c8c",WedgePart:"b5a3e6",TrussPart:"8e6b26",CornerWedgePart:"b5a3e6",Seat:"555555",VehicleSeat:"555555",SpawnLocation:"4e4b43",Model:"47535b",Folder:"8e8e8e",Script:"4a7a4a",LocalScript:"4a7a4a",ModuleScript:"4a7a4a",SurfaceGui:"4a4a4a",BillboardGui:"4a4a4a",ScreenGui:"4a4a4a",Frame:"4a4a4a",TextLabel:"4a4a4a",TextButton:"4a4a4a",ImageLabel:"4a4a4a",ImageButton:"4a4a4a",Decal:"58a6ff",Texture:"58a6ff",Sound:"a64da6",PointLight:"fff2cc",SpotLight:"fff2cc",SurfaceLight:"fff2cc",Fire:"ff6b35",Smoke:"aaaaaa",ParticleEmitter:"ff6b35",Beam:"ff6b35",Attachment:"484f58",Weld:"8c8c8c",WeldConstraint:"8c8c8c",Motor6D:"b5a3e6",Force:"f85149",VectorForce:"f85149",AlignPosition:"238636",AlignOrientation:"238636",BlockMesh:"8c8c8c",CylinderMesh:"8c8c8c",SpecialMesh:"8c8c8c"}

async function loadAsset() {
	const id = document.getElementById('assetId').value.trim()
	if (!id) return
	const btn = document.getElementById('fetchBtn')
	const st = document.getElementById('status')
	btn.disabled = true; st.className = 'status loading'; st.textContent = 'Fetching asset...'
	try {
		const r = await window.fetch('/asset/' + id)
		const j = await r.json()
		if (j.error) throw new Error(j.error)
		data = j
		st.className = 'status success'
		st.textContent = 'Loaded ' + j.instanceCount + ' instances from asset ' + j.assetId
		document.getElementById('mainArea').style.display = 'flex'
		document.getElementById('infoBar').textContent = 'Asset ' + j.assetId + ' | ' + j.instanceCount + ' instances | Type: ' + (j.assetTypeId || 'unknown')
		renderExplorer(j.instances)
		renderSource(j)
		init3D(j.instances)
	} catch (e) { st.className = 'status error'; st.textContent = e.message }
	btn.disabled = false
}

function switchTab(t) {
	document.querySelectorAll('.sidebar .tab').forEach(e => e.classList.toggle('active', e.dataset.tab === t))
	document.querySelectorAll('.sidebar .panel').forEach(e => e.classList.toggle('active', e.id === t + 'Panel'))
}
function switchMainTab(t) {
	document.querySelectorAll('.main .tab-bar:last-of-type .tab').forEach(e => e.classList.toggle('active', e.dataset.tab === t))
	document.getElementById('viewer3dPanel').classList.toggle('active', t === '3d')
	document.getElementById('sourcePanel').classList.toggle('active', t === 'source')
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML }

/* ═══ Explorer ═══ */

const exState = { nodes: [], focusedIdx: -1 }

function renderExplorer(instances) {
	const el = document.getElementById('explorerTree')
	el.innerHTML = ''
	exState.nodes = []
	exState.focusedIdx = -1

	function render(arr, parent, depth) {
		for (const inst of arr) {
			const hasKids = inst.Children && inst.Children.length > 0
			const color = CLASS_COLORS[inst.ClassName] || '58a6ff'
			const node = document.createElement('div')
			node.className = 'ex-node' + (depth === 0 ? ' root' : '')
			const header = document.createElement('div')
			header.className = 'ex-header'
			header.tabIndex = -1
			const toggle = document.createElement('span')
			toggle.className = 'ex-toggle'
			toggle.textContent = hasKids ? '\u25B6' : '\u00A0'
			const icon = document.createElement('span')
			icon.className = 'ex-icon'
			icon.style.background = '#' + color
			icon.textContent = (inst.ClassName || '?')[0]
			const cls = document.createElement('span')
			cls.className = 'ex-class'
			cls.textContent = inst.ClassName
			const name = document.createElement('span')
			name.className = 'ex-name'
			name.textContent = inst.Name || ''
			header.append(toggle, icon, cls, document.createTextNode(' '), name)
			if (hasKids) {
				const cnt = document.createElement('span')
				cnt.className = 'ex-count'
				cnt.textContent = '(' + inst.Children.length + ')'
				header.appendChild(cnt)
			}
			const kids = document.createElement('div')
			kids.className = 'ex-children'
			let open = false
			function setOpen(v) {
				open = v
				kids.classList.toggle('open', open)
				toggle.textContent = open ? '\u25BC' : (hasKids ? '\u25B6' : '\u00A0')
			}
			header.addEventListener('click', e => { e.stopPropagation(); setOpen(!open); selectInstance(inst, header) })
			if (hasKids) header.addEventListener('dblclick', e => { e.stopPropagation(); focusInstance3D(inst) })
			exState.nodes.push({ inst, header, kids, setOpen, open: () => open, depth, el: node })
			if (hasKids) render(inst.Children, kids, depth + 1)
			node.append(header, kids)
			parent.appendChild(node)
		}
	}

	render(instances, el, 0)

	el.addEventListener('keydown', e => {
		const nodes = exState.nodes
		if (!nodes.length) return
		if (e.key === 'ArrowDown') { e.preventDefault(); exState.focusedIdx = Math.min(exState.focusedIdx + 1, nodes.length - 1); focusNode(exState.focusedIdx) }
		else if (e.key === 'ArrowUp') { e.preventDefault(); exState.focusedIdx = Math.max(exState.focusedIdx - 1, 0); focusNode(exState.focusedIdx) }
		else if (e.key === 'ArrowRight') {
			e.preventDefault()
			if (exState.focusedIdx >= 0) { const n = nodes[exState.focusedIdx]; if (n.inst.Children && n.inst.Children.length && !n.open()) n.setOpen(true) }
		}
		else if (e.key === 'ArrowLeft') {
			e.preventDefault()
			if (exState.focusedIdx >= 0) {
				const n = nodes[exState.focusedIdx]
				if (n.open()) n.setOpen(false)
				else if (n.depth > 0) { for (let i = exState.focusedIdx - 1; i >= 0; i--) { if (nodes[i].depth < n.depth) { exState.focusedIdx = i; focusNode(i); break } } }
			}
		}
		else if (e.key === 'Enter') { e.preventDefault(); if (exState.focusedIdx >= 0) { const n = nodes[exState.focusedIdx]; selectInstance(n.inst, n.header); focusInstance3D(n.inst) } }
		else if (e.key === ' ') { e.preventDefault(); if (exState.focusedIdx >= 0) { const n = nodes[exState.focusedIdx]; if (n.inst.Children && n.inst.Children.length) n.setOpen(!n.open()) } }
	})
	el.addEventListener('focus', () => { if (exState.focusedIdx < 0 && exState.nodes.length) { exState.focusedIdx = 0; focusNode(0) } })
}

function focusNode(idx) {
	const n = exState.nodes[idx]
	if (!n) return
	n.header.focus()
	n.header.scrollIntoView({ block: 'nearest' })
}

function selectInstance(inst, headerEl) {
	document.querySelectorAll('.ex-header.selected').forEach(e => e.classList.remove('selected'))
	if (headerEl) headerEl.classList.add('selected')
	selectedNode = inst
	switchTab('props')
	const panel = document.getElementById('propsContent')
	let html = '<h3>' + esc(inst.ClassName) + ' &mdash; ' + esc(inst.Name || '(unnamed)') + '</h3>'
	const skip = new Set(['ClassName', 'Name', 'Children'])
	for (const [k, v] of Object.entries(inst)) {
		if (skip.has(k)) continue
		const isObj = typeof v === 'object' && v !== null
		const display = isObj ? JSON.stringify(v) : String(v)
		html += '<div class="prop-row"><span class="prop-key">' + esc(k) + '</span><span class="prop-val' + (isObj ? ' obj' : '') + '">' + esc(display) + '</span></div>'
	}
	if (inst.Children && inst.Children.length) html += '<div class="prop-row"><span class="prop-key">Children</span><span class="prop-val obj">' + inst.Children.length + ' items</span></div>'
	panel.innerHTML = html
	highlight3D(inst)
}

function filterExplorer() {
	const q = document.getElementById('searchInput').value.toLowerCase()
	exState.nodes.forEach(n => {
		const text = n.header.textContent.toLowerCase()
		const match = !q || text.includes(q)
		n.el.style.display = match ? '' : 'none'
		if (match && q) {
			let parent = n.el.parentElement
			while (parent && parent !== document.getElementById('explorerTree')) {
				if (parent.classList.contains('ex-children')) parent.classList.add('open')
				parent = parent.parentElement
			}
			for (let i = exState.nodes.indexOf(n) - 1; i >= 0; i--) {
				const ancestor = exState.nodes[i]
				if (ancestor.depth < n.depth) { ancestor.setOpen(true); break }
			}
		}
	})
}

/* ═══ Source ═══ */

let rawSource = null, sourceJson = ''

function renderSource(j) {
	sourceJson = JSON.stringify(j, null, 2)
	rawSource = null
	const content = document.getElementById('sourceContent')
	const lines = document.getElementById('sourceLines')
	content.innerHTML = syntaxHighlight(sourceJson)
	const lineCount = sourceJson.split('\n').length
	lines.innerHTML = ''
	for (let i = 1; i <= lineCount; i++) lines.innerHTML += '<div>' + i + '</div>'
	const scrollEl = document.getElementById('sourceScroll')
	const linesEl = document.getElementById('sourceLines')
	scrollEl.onscroll = () => { linesEl.scrollTop = scrollEl.scrollTop }
	document.getElementById('sourceSearchInfo').textContent = ''
	fetch('/asset/' + j.assetId + '/raw').then(r => r.ok ? r.text() : null).then(t => { rawSource = t }).catch(() => {})
}

function syntaxHighlight(json) {
	return json
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"(\\u[\\da-fA-F]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?/g, m => {
			let cls = 'json-string'
			if (m.endsWith(':')) { cls = 'json-key'; m = m.slice(0, -1) + ':' }
			return '<span class="' + cls + '">' + esc(m) + '</span>'
		})
		.replace(/\\b(-?\\d+\\.?\\d*([eE][+-]?\\d+)?)\\b/g, '<span class="json-number">$1</span>')
		.replace(/\\b(true|false)\\b/g, '<span class="json-bool">$1</span>')
		.replace(/\\bnull\\b/g, '<span class="json-null">null</span>')
}

function searchSource() {
	const q = document.getElementById('sourceSearch').value
	const info = document.getElementById('sourceSearchInfo')
	if (!q) { document.getElementById('sourceContent').innerHTML = syntaxHighlight(sourceJson); info.textContent = ''; return }
	const text = rawSource || sourceJson
	const regex = new RegExp('(' + q.replace(/[.*+?^\$\{\}()|[\]\\]/g, m => '\\' + m) + ')', 'gi')
	const matches = text.match(regex)
	info.textContent = matches ? matches.length + ' matches' : 'No matches'
	const highlighted = (rawSource || sourceJson)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(regex, '<mark style="background:#58a6ff33;color:#f0f6fc">$1</mark>')
	document.getElementById('sourceContent').innerHTML = highlighted
}

function downloadSource() {
	const text = rawSource || sourceJson
	const blob = new Blob([text], { type: 'text/plain' })
	const a = document.createElement('a')
	a.href = URL.createObjectURL(blob)
	a.download = 'asset_' + (data ? data.assetId : 'unknown') + (rawSource ? '.rbxm' : '.json')
	a.click()
	URL.revokeObjectURL(a.href)
}

/* ═══ 3D Viewer ═══ */

function init3D(instances) {
	const container = document.getElementById('viewer3d')
	const empty = document.getElementById('viewerEmpty')
	if (empty) empty.remove()
	if (renderer) { renderer.dispose(); renderer.domElement.remove(); renderer = null }

	const w = container.clientWidth, h = container.clientHeight
	scene = new THREE.Scene()
	scene.background = new THREE.Color(0x1a1a2e)
	camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 10000)
	renderer = new THREE.WebGLRenderer({ antialias: true })
	renderer.setSize(w, h)
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
	container.appendChild(renderer.domElement)

	scene.add(new THREE.AmbientLight(0xffffff, 0.6))
	const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
	dirLight.position.set(50, 100, 75)
	scene.add(dirLight)
	scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.4))

	gridHelper = new THREE.GridHelper(100, 100, 0x30363d, 0x21262d)
	scene.add(gridHelper)

	meshGroup = new THREE.Group()
	scene.add(meshGroup)
	allMeshes = []
	const bbox = new THREE.Box3()
	let hasParts = false

	function addMeshes(inst) {
		const className = inst.ClassName
		if (className === 'Part' || className === 'MeshPart' || className === 'WedgePart' || className === 'TrussPart' || className === 'CornerWedgePart') {
			const size = inst.Size
			const cf = inst.CFrame
			if (size) {
				const geo = new THREE.BoxGeometry(size[0], size[1], size[2])
				const color = parseInt(CLASS_COLORS[className] || '39c4cc', 16)
				const mat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.85 })
				const mesh = new THREE.Mesh(geo, mat)
				if (cf && cf.length >= 12) {
					mesh.position.set(cf[0], cf[1], cf[2])
					const m = new THREE.Matrix4()
					m.set(cf[3], cf[4], cf[5], 0, cf[6], cf[7], cf[8], 0, cf[9], cf[10], cf[11], 0, 0, 0, 0, 1)
					mesh.quaternion.setFromRotationMatrix(m)
				} else if (inst.Position) {
					mesh.position.set(inst.Position[0], inst.Position[1], inst.Position[2])
				}
				mesh.userData.instance = inst
				meshGroup.add(mesh)
				allMeshes.push(mesh)
				bbox.expandByObject(mesh)
				hasParts = true
			}
		}
		if (inst.Children) inst.Children.forEach(addMeshes)
	}
	instances.forEach(addMeshes)

	const target = new THREE.Vector3()
	if (hasParts) {
		bbox.getCenter(target)
		const dist = bbox.getSize(new THREE.Vector3()).length() * 0.8
		camera.position.set(target.x + dist * 0.7, target.y + dist * 0.5, target.z + dist * 0.7)
	} else {
		camera.position.set(50, 50, 50)
	}
	camera.lookAt(target)

	orbitState = {
		theta: Math.atan2(camera.position.x - target.x, camera.position.z - target.z),
		phi: Math.acos(Math.min(1, Math.max(-1, (camera.position.y - target.y) / camera.position.distanceTo(target)))),
		radius: camera.position.distanceTo(target),
		target: target.clone(),
		isDragging: false, button: -1, prevX: 0, prevY: 0
	}

	const cv = renderer.domElement
	cv.addEventListener('mousedown', e => { orbitState.isDragging = true; orbitState.button = e.button; orbitState.prevX = e.clientX; orbitState.prevY = e.clientY })
	cv.addEventListener('mousemove', e => {
		if (!orbitState.isDragging) return
		const dx = e.clientX - orbitState.prevX, dy = e.clientY - orbitState.prevY
		orbitState.prevX = e.clientX; orbitState.prevY = e.clientY
		if (orbitState.button === 0) {
			orbitState.theta -= dx * 0.005
			orbitState.phi = Math.max(0.01, Math.min(Math.PI - 0.01, orbitState.phi + dy * 0.005))
		} else if (orbitState.button === 2 || orbitState.button === 1) {
			const panSpeed = orbitState.radius * 0.002
			const cx = Math.cos(orbitState.theta), sx = Math.sin(orbitState.theta)
			const right = new THREE.Vector3(-sx, 0, cx).normalize()
			orbitState.target.addScaledVector(right, -dx * panSpeed)
			orbitState.target.addScaledVector(new THREE.Vector3(0, 1, 0), dy * panSpeed)
		}
		updateOrbitCamera()
	})
	cv.addEventListener('mouseup', () => { orbitState.isDragging = false })
	cv.addEventListener('mouseleave', () => { orbitState.isDragging = false })
	cv.addEventListener('contextmenu', e => e.preventDefault())
	cv.addEventListener('wheel', e => {
		e.preventDefault()
		orbitState.radius *= e.deltaY > 0 ? 1.1 : 0.9
		orbitState.radius = Math.max(0.5, orbitState.radius)
		updateOrbitCamera()
	}, { passive: false })
	cv.addEventListener('dblclick', e => {
		const rect = cv.getBoundingClientRect()
		const mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
		const raycaster = new THREE.Raycaster()
		raycaster.setFromCamera(mouse, camera)
		const hits = raycaster.intersectObjects(meshGroup.children)
		if (hits.length) focusInstance3D(hits[0].object.userData.instance)
	})

	const ro = new ResizeObserver(() => {
		if (!renderer) return
		const w2 = container.clientWidth, h2 = container.clientHeight
		camera.aspect = w2 / h2; camera.updateProjectionMatrix()
		renderer.setSize(w2, h2)
	})
	ro.observe(container)

	document.getElementById('viewerControls').style.display = 'block'
	document.getElementById('btnGrid').classList.toggle('active', showGrid)
	document.getElementById('btnWireframe').classList.toggle('active', showWireframe)

	function animate() { requestAnimationFrame(animate); renderer.render(scene, camera) }
	animate()
	document.getElementById('viewerInfo').innerHTML = 'LMB orbit &middot; RMB pan &middot; Scroll zoom &middot; Dbl-click focus'
}

function updateOrbitCamera() {
	const o = orbitState
	camera.position.set(o.target.x + o.radius * Math.sin(o.phi) * Math.cos(o.theta), o.target.y + o.radius * Math.cos(o.phi), o.target.z + o.radius * Math.sin(o.phi) * Math.sin(o.theta))
	camera.lookAt(o.target)
}

function highlight3D(inst) {
	allMeshes.forEach(m => {
		m.material.emissive.set(0x000000); m.material.emissiveIntensity = 0
		if (m.userData.instance === inst) { m.material.emissive.set(0x58a6ff); m.material.emissiveIntensity = 0.4 }
	})
}

function focusInstance3D(inst) {
	if (!inst || !orbitState) return
	const mesh = allMeshes.find(m => m.userData.instance === inst)
	if (mesh) {
		const box = new THREE.Box3().setFromObject(mesh)
		const center = box.getCenter(new THREE.Vector3())
		const size = box.getSize(new THREE.Vector3()).length()
		orbitState.target.copy(center)
		orbitState.radius = Math.max(size * 2, 5)
		orbitState.theta = Math.atan2(camera.position.x - orbitState.target.x, camera.position.z - orbitState.target.z)
		updateOrbitCamera()
		highlight3D(inst)
	}
}

function frameAll() {
	if (!meshGroup || !orbitState || meshGroup.children.length === 0) return
	const bbox = new THREE.Box3().setFromObject(meshGroup)
	orbitState.target.copy(bbox.getCenter(new THREE.Vector3()))
	orbitState.radius = bbox.getSize(new THREE.Vector3()).length() * 0.8
	orbitState.theta = Math.PI / 4; orbitState.phi = Math.PI / 3
	updateOrbitCamera()
}

function toggleWireframe() { showWireframe = !showWireframe; allMeshes.forEach(m => { m.material.wireframe = showWireframe }); document.getElementById('btnWireframe').classList.toggle('active', showWireframe) }
function toggleGrid() { showGrid = !showGrid; if (gridHelper) gridHelper.visible = showGrid; document.getElementById('btnGrid').classList.toggle('active', showGrid) }
</script>
</body>
</html>`)
})

function countInstances(instances) {
	let count = instances.length
	for (const inst of instances) {
		if (inst.Children) {
			count += countInstances(inst.Children)
		}
	}
	return count
}

function flattenInstances(instances, result, path) {
	for (const inst of instances) {
		const currentPath = path ? `${path}/${inst.getProperty("Name") || "?"}` : (inst.getProperty("Name") || "?")
		const json = instanceToJSON(inst)
		json.path = currentPath
		result.push(json)
		if (inst.Children && inst.Children.length > 0) {
			flattenInstances(inst.Children, result, currentPath)
		}
	}
}

app.listen(PORT, HOST, () => {
	console.log(`RBXM Asset Server running on http://${HOST}:${PORT}`)
	console.log(`\nEndpoints:`)
	console.log(`  GET /                             - Web UI`)
	console.log(`  GET /legacy                       - Previous web UI`)
	console.log(`  GET /asset/:id                    - Parse asset (nested)`)
	console.log(`  GET /asset/:id/tree               - Parse asset (flat)`)
	console.log(`  GET /asset/:id/search?class=X     - Search by class`)
	console.log(`  GET /asset/:id/class/:className   - Get class instances`)
	console.log(`  GET /asset/:id/raw                - Raw asset buffer`)
	console.log(`  GET /health                       - Health check`)
})
