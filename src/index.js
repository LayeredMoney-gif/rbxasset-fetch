import { RBXModelParser, jsonReplacer } from "../lib/RBXParser.js"
import { bufferToString } from "../lib/ByteReader.js"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

function getEnvVars(env) {
    return {
        ROBLOX_COOKIE: env.ROBLOX_COOKIE || "",
        ALLOW_HEADER_COOKIE: env.ALLOW_HEADER_COOKIE || "false",
        ASSET_CACHE_TTL_MS: parseInt(env.ASSET_CACHE_TTL_MS || "300000", 10),
    }
}

// ─── Helpers ───

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer)
    let binary = ""
    for (let i = 0; i < bytes.byteLength; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    }
    return btoa(binary)
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data, jsonReplacer), {
        status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    })
}

function err(message, status = 500) {
    return json({ error: message }, status)
}

function getCookie(request, envVars) {
    if (envVars.ALLOW_HEADER_COOKIE === "true" && request.headers.get("x-roblox-cookie")) {
        return String(request.headers.get("x-roblox-cookie")).trim()
    }
    return (envVars.ROBLOX_COOKIE || "").trim()
}

function countInstances(instances) {
    let count = instances.length
    for (const inst of instances) {
        if (inst.Children) count += countInstances(inst.Children)
    }
    return count
}

function countFiltered(instances, ignoreSet) {
    let count = 0
    for (const inst of instances) {
        if (ignoreSet.has(inst.ClassName)) {
            count += 1 + (inst.Children ? countFiltered(inst.Children, ignoreSet) : 0)
        } else if (inst.Children) {
            count += countFiltered(inst.Children, ignoreSet)
        }
    }
    return count
}

function parseList(str) {
    if (!str) return new Set()
    return new Set(str.split(",").map(s => s.trim()).filter(Boolean))
}

function stripProperties(instances, ignoreProps) {
    if (ignoreProps.size === 0) return instances
    return instances.map(inst => {
        const out = {}
        for (const [k, v] of Object.entries(inst)) {
            if (!ignoreProps.has(k)) {
                out[k] = k === "Children" && Array.isArray(v) ? stripProperties(v, ignoreProps) : v
            }
        }
        return out
    })
}

function filterInstances(instances, ignoreSet) {
    if (ignoreSet.size === 0) return instances
    return instances
        .filter(inst => !ignoreSet.has(inst.ClassName))
        .map(inst => {
            if (inst.Children && inst.Children.length > 0) {
                return { ...inst, Children: filterInstances(inst.Children, ignoreSet) }
            }
            return inst
        })
}

function flattenInstances(instances, result, path, ignoreSet) {
    for (const inst of instances) {
        if (ignoreSet && ignoreSet.has(inst.ClassName)) continue
        const currentPath = path
            ? `${path}/${inst.getProperty("Name") || "?"}`
            : (inst.getProperty("Name") || "?")
        const json = instanceToJSON(inst)
        json.path = currentPath
        result.push(json)
        if (inst.Children && inst.Children.length > 0) {
            flattenInstances(inst.Children, result, currentPath, ignoreSet)
        }
    }
}

// ─── Serialization ───

function instanceToJSON(instance) {
    const json = {
        ClassName: instance.getProperty("ClassName"),
        Name: instance.getProperty("Name"),
    }
    const skipProps = new Set(["ClassName", "Name", "Parent", "Children"])
    for (const [key, prop] of Object.entries(instance.Properties)) {
        if (!skipProps.has(key)) {
            json[key] = serializeValue(prop.value, prop.type)
        }
    }
    if (instance.Children && instance.Children.length > 0) {
        json.Children = instance.Children.map(child => instanceToJSON(child))
    }
    return json
}

function serializeValue(value, type) {
    if (value === null || value === undefined) return null
    if (type === "Instance" && value && typeof value === "object" && value.ClassName) {
        return {
            __type: "Instance",
            ClassName: value.getProperty("ClassName"),
            Name: value.getProperty("Name")
        }
    }
    if (Array.isArray(value)) return value
    if (typeof value === "object" && value !== null && !(value instanceof Date)) {
        const result = {}
        for (const [k, v] of Object.entries(value)) {
            result[k] = serializeValue(v, type)
        }
        return result
    }
    if (typeof value === "bigint") return value.toString()
    return value
}

// ─── KV helpers ───

async function kvGet(kv, key) {
    if (!kv) return null
    try {
        const val = await kv.get(key, { type: "json" })
        return val || null
    } catch { return null }
}

async function kvPut(kv, key, value, ttlSeconds) {
    if (!kv) return
    try {
        await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds })
    } catch {}
}

async function kvGetRaw(kv, key) {
    if (!kv) return null
    try {
        const val = await kv.get(key, { type: "arrayBuffer" })
        return val || null
    } catch { return null }
}

async function kvPutRaw(kv, key, value, ttlSeconds) {
    if (!kv) return
    try {
        await kv.put(key, value, { expirationTtl: ttlSeconds })
    } catch {}
}

// ─── CSRF token ───

async function getCsrfToken(cookie, kv, envVars) {
    const cacheKey = "csrf:token"
    const cached = await kvGet(kv, cacheKey)
    if (cached && cached.token) return cached.token
    const cookieHeader = `.ROBLOSECURITY=${cookie}`
    try {
        const res = await fetch("https://auth.roblox.com/v2/logout", {
            method: "POST",
            headers: { "User-Agent": USER_AGENT, "Cookie": cookieHeader }
        })
        const token = res.headers.get("x-csrf-token") || ""
        if (token) {
            await kvPut(kv, cacheKey, { token }, 300)
        }
        return token
    } catch {
        return ""
    }
}

// ─── Fetch with retry ───

async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const res = await fetch(url, options)
        if (res.status === 429) {
            const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10)
            const delay = Math.min(retryAfter * 1000, 30000)
            await new Promise(r => setTimeout(r, delay))
            continue
        }
        return res
    }
    throw new Error("Rate limited too many times")
}

// ─── Asset fetch pipeline ───

async function fetchAssetUncached(assetId, cookie, kv) {
    try {
        const res = await fetchWithRetry(
            `https://assetdelivery.roproxy.com/v2/asset/?id=${assetId}`,
            { headers: { "User-Agent": USER_AGENT, "Accept": "application/json" } }
        )
        if (res.ok) {
            const json = await res.json()
            if (json.locations && json.locations.length > 0) {
                return await downloadFromLocations(json)
            }
        }
    } catch {}

    if (!cookie) throw new Error("RoProxy failed and no cookie provided. Set ROBLOX_COOKIE secret")

    const cookieHeader = `.ROBLOSECURITY=${cookie}`
    const csrfToken = await getCsrfToken(cookie, kv)
    const headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Roblox-Browser-Asset-Request": "true"
    }
    if (cookieHeader) headers["Cookie"] = cookieHeader
    if (csrfToken) headers["X-CSRF-TOKEN"] = csrfToken

    const url = `https://assetdelivery.roblox.com/v2/asset/?id=${assetId}`
    const res = await fetchWithRetry(url, { headers })

    if (!res.ok) {
        if (res.status === 403) {
            const newCsrf = res.headers.get("x-csrf-token")
            if (newCsrf) {
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
    const cdnRes = await fetch(cdnUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    })
    if (!cdnRes.ok) throw new Error(`CDN download failed: ${cdnRes.status}`)
    const buffer = new Uint8Array(await cdnRes.arrayBuffer())
    const contentType = cdnRes.headers.get("content-type") || ""
    if (buffer.length < 8) throw new Error(`CDN returned empty buffer (${buffer.length} bytes)`)
    if (contentType.includes("text/html")) {
        const preview = bufferToString(buffer.subarray(0, Math.min(200, buffer.length)))
        throw new Error(`CDN returned HTML instead of asset (${contentType}). Preview: ${JSON.stringify(preview)}`)
    }
    return { buffer, assetTypeId: json.assetTypeId }
}

async function processAssetResponse(res) {
    const json = await res.json()
    if (json.errors) throw new Error(`Roblox API error: ${JSON.stringify(json.errors)}`)
    if (!json.locations || json.locations.length === 0) throw new Error(`No download locations for asset`)
    const cdnUrl = json.locations[0].location
    const cdnRes = await fetch(cdnUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    })
    if (!cdnRes.ok) throw new Error(`CDN download failed: ${cdnRes.status}`)
    const buffer = new Uint8Array(await cdnRes.arrayBuffer())
    if (buffer.length < 8) throw new Error(`CDN returned empty buffer (${buffer.length} bytes)`)
    const contentType = cdnRes.headers.get("content-type") || ""
    if (contentType.includes("text/html")) {
        const preview = bufferToString(buffer.subarray(0, Math.min(200, buffer.length)))
        throw new Error(`CDN returned HTML instead of asset (${contentType}). Preview: ${JSON.stringify(preview)}`)
    }
    return { buffer, assetTypeId: json.assetTypeId }
}

// ─── Fetch with caching ───

const memoryCache = new Map()

async function fetchAndParse(assetId, cookie, kv, envVars) {
    const cacheKey = `${assetId}:${cookie || "anonymous"}`

    const cached = await kvGet(kv, `parsed:${cacheKey}`)
    if (cached && Date.now() - cached.createdAt < envVars.ASSET_CACHE_TTL_MS) {
        return cached.value
    }

    const memCached = memoryCache.get(cacheKey)
    if (memCached && Date.now() - memCached.createdAt < envVars.ASSET_CACHE_TTL_MS) {
        return memCached.value
    }

    const { buffer, assetTypeId } = await fetchAssetUncached(assetId, cookie, kv)
    const parser = RBXModelParser.parse(buffer)
    const instances = parser.result.map(inst => instanceToJSON(inst))
    const result = {
        assetId,
        assetTypeId,
        meta: parser.meta,
        instanceCount: countInstances(instances),
        instances
    }

    const entry = { createdAt: Date.now(), value: result }
    memoryCache.set(cacheKey, entry)
    const ttlSeconds = Math.floor(envVars.ASSET_CACHE_TTL_MS / 1000)
    await kvPut(kv, `parsed:${cacheKey}`, entry, ttlSeconds)

    return result
}

// ─── Main handler ───

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url)
        const path = url.pathname
        const envVars = getEnvVars(env)
        const kv = env.ASSET_CACHE

        try {
            // CORS preflight
            if (request.method === "OPTIONS") {
                return new Response(null, {
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "x-roblox-cookie",
                    }
                })
            }

            // Health check
            if (path === "/health") {
                return json({
                    status: "ok",
                    cookieLoaded: !!envVars.ROBLOX_COOKIE,
                    headerCookieEnabled: envVars.ALLOW_HEADER_COOKIE === "true",
                    cacheEntries: memoryCache.size,
                    kvEnabled: !!kv,
                    timestamp: new Date().toISOString()
                })
            }

            // GET /asset/:id
            const assetMatch = path.match(/^\/asset\/(\d+)$/)
            if (assetMatch && request.method === "GET") {
                const assetId = parseInt(assetMatch[1], 10)
                if (!Number.isSafeInteger(assetId) || assetId <= 0) return err("Invalid asset ID", 400)
                const cookie = getCookie(request, envVars)
                const full = await fetchAndParse(assetId, cookie, kv, envVars)
                const ignoreSet = parseList(url.searchParams.get("ignoreClasses"))
                const ignoreProps = parseList(url.searchParams.get("ignoreProperties"))
                let instances = filterInstances(full.instances, ignoreSet)
                instances = stripProperties(instances, ignoreProps)
                return json({
                    assetId,
                    assetTypeId: full.assetTypeId,
                    meta: full.meta,
                    instanceCount: ignoreSet.size > 0
                        ? countInstances(full.instances) - countFiltered(full.instances, ignoreSet)
                        : full.instanceCount,
                    instances
                })
            }

            // GET /asset/:id/tree
            const treeMatch = path.match(/^\/asset\/(\d+)\/tree$/)
            if (treeMatch && request.method === "GET") {
                const assetId = parseInt(treeMatch[1], 10)
                if (!Number.isSafeInteger(assetId) || assetId <= 0) return err("Invalid asset ID", 400)
                const cookie = getCookie(request, envVars)
                const full = await fetchAndParse(assetId, cookie, kv, envVars)
                const ignoreSet = parseList(url.searchParams.get("ignoreClasses"))
                const ignoreProps = parseList(url.searchParams.get("ignoreProperties"))
                const flat = []
                flattenInstances(full.instances, flat, "", ignoreSet)
                const filtered = stripProperties(flat, ignoreProps)
                return json({
                    assetId,
                    assetTypeId: full.assetTypeId,
                    totalInstances: filtered.length,
                    instances: filtered
                })
            }

            // GET /asset/:id/search?class=X&prop=Y&value=Z
            // Supports comma-separated classes: ?class=Script,ModuleScript
            const searchMatch = path.match(/^\/asset\/(\d+)\/search$/)
            if (searchMatch && request.method === "GET") {
                const assetId = parseInt(searchMatch[1], 10)
                if (!Number.isSafeInteger(assetId) || assetId <= 0) return err("Invalid asset ID", 400)

                const classParam = url.searchParams.get("class")
                const classNames = classParam
                    ? new Set(classParam.split(",").map(s => s.trim()).filter(Boolean))
                    : null

                const propName = url.searchParams.get("prop")
                const propValue = url.searchParams.get("value")
                const ignoreSet = parseList(url.searchParams.get("ignoreClasses"))
                const ignoreProps = parseList(url.searchParams.get("ignoreProperties"))

                const cookie = getCookie(request, envVars)
                const full = await fetchAndParse(assetId, cookie, kv, envVars)

                const results = []

                function searchInstances(instances, currentPath) {
                    for (const inst of instances) {
                        if (ignoreSet.has(inst.ClassName)) continue
                        const p = currentPath
                            ? `${currentPath}/${inst.Name}`
                            : inst.Name
                        let matches = true
                        if (classNames && !classNames.has(inst.ClassName)) matches = false
                        if (propName && inst[propName] === undefined) matches = false
                        if (propValue && String(inst[propName]) !== propValue) matches = false
                        if (matches && (classNames || propName)) {
                            results.push(
                                stripProperties([{ ...inst, path: p }], ignoreProps)[0]
                            )
                        }
                        if (inst.Children && inst.Children.length > 0) {
                            searchInstances(inst.Children, p)
                        }
                    }
                }

                searchInstances(full.instances, "")

                return json({
                    assetId,
                    assetTypeId: full.assetTypeId,
                    query: {
                        class: classParam || null,
                        prop: propName || null,
                        value: propValue || null
                    },
                    resultCount: results.length,
                    results
                })
            }

            // GET /asset/:id/class/:classNames
            // Supports comma-separated: /asset/123/class/Script,ModuleScript
            const classMatch = path.match(/^\/asset\/(\d+)\/class\/(.+)$/)
            if (classMatch && request.method === "GET") {
                const assetId = parseInt(classMatch[1], 10)
                if (!Number.isSafeInteger(assetId) || assetId <= 0) return err("Invalid asset ID", 400)

                const classParam = decodeURIComponent(classMatch[2])
                const classNames = new Set(
                    classParam.split(",").map(s => s.trim()).filter(Boolean)
                )

                const ignoreSet = parseList(url.searchParams.get("ignoreClasses"))
                const ignoreProps = parseList(url.searchParams.get("ignoreProperties"))

                const cookie = getCookie(request, envVars)
                const full = await fetchAndParse(assetId, cookie, kv, envVars)

                const results = []

                function findByClass(instances, currentPath) {
                    for (const inst of instances) {
                        if (ignoreSet.has(inst.ClassName)) continue
                        const p = currentPath
                            ? `${currentPath}/${inst.Name}`
                            : inst.Name
                        if (classNames.has(inst.ClassName)) {
                            results.push(
                                stripProperties([{ ...inst, path: p }], ignoreProps)[0]
                            )
                        }
                        if (inst.Children && inst.Children.length > 0) {
                            findByClass(inst.Children, p)
                        }
                    }
                }

                findByClass(full.instances, "")

                return json({
                    assetId,
                    assetTypeId: full.assetTypeId,
                    classNames: [...classNames],
                    resultCount: results.length,
                    results
                })
            }

            // GET /asset/:id/raw
            const rawMatch = path.match(/^\/asset\/(\d+)\/raw$/)
            if (rawMatch && request.method === "GET") {
                const assetId = parseInt(rawMatch[1], 10)
                if (!Number.isSafeInteger(assetId) || assetId <= 0) return err("Invalid asset ID", 400)
                const cookie = getCookie(request, envVars)

                const rawCacheKey = `raw:${assetId}:${cookie || "anonymous"}`
                const cachedRaw = await kvGetRaw(kv, rawCacheKey)
                if (cachedRaw) {
                    const isXML = cachedRaw.byteLength > 7
                        && cachedRaw[0] === 0x3C
                        && cachedRaw[1] === 0x72
                    const content = isXML
                        ? bufferToString(new Uint8Array(cachedRaw))
                        : arrayBufferToBase64(cachedRaw)
                    return new Response(content, {
                        headers: {
                            "Content-Type": "text/plain; charset=utf-8",
                            "Access-Control-Allow-Origin": "*"
                        }
                    })
                }

                const { buffer } = await fetchAssetUncached(assetId, cookie, kv)
                const isXML = buffer.length > 7
                    && buffer[0] === 0x3C
                    && buffer[1] === 0x72
                const content = isXML
                    ? bufferToString(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
                    : arrayBufferToBase64(buffer)

                ctx.waitUntil(kvPutRaw(kv, rawCacheKey, buffer.buffer, 3600))

                return new Response(content, {
                    headers: {
                        "Content-Type": "text/plain; charset=utf-8",
                        "Access-Control-Allow-Origin": "*"
                    }
                })
            }

            return err("Not found", 404)

        } catch (e) {
            return err(e.message || "Internal error", 500)
        }
    }
}
