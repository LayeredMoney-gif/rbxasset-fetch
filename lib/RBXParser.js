import { ByteReader, bufferToString } from "./ByteReader.js"

const RBXDataTypes = [
	"Unknown", "string", "bool", "int", "float", "double", "UDim", "UDim2", "Ray", "Faces",
	"Axes", "BrickColor", "Color3", "Vector2", "Vector3", "Vector2int16", "CFrame", "Quaternion", "Enum", "Instance",
	"Vector3int16", "NumberSequence", "ColorSequence", "NumberRange", "Rect2D", "PhysicalProperties", "Color3uint8", "int64", "SharedString", "UnknownScriptFormat",
	"Optional", "UniqueId", "Font", "SecurityCapabilities", "Content"
]

class RBXInstanceArray extends Array {
	findFirstChild(name, recursive = false) {
		return RBXInstanceUtils.findFirstChild(this, name, recursive)
	}
	findFirstChildOfClass(className, recursive = false) {
		return RBXInstanceUtils.findFirstChildOfClass(this, className, recursive)
	}
}

const RBXInstanceUtils = {
	findFirstChild(target, name, recursive = false) {
		const children = target instanceof RBXInstance ? target.Children : target

		for (const child of children) {
			if (child.getProperty("Name") === name) {
				return child
			}
		}

		if (recursive) {
			const arrays = [children]

			while (arrays.length) {
				for (const desc of arrays.shift()) {
					if (desc.getProperty("Name") === name) {
						return desc
					}

					if (desc.Children.length) {
						arrays.push(desc.Children)
					}
				}
			}
		}

		return null
	},

	findFirstChildOfClass(target, className, recursive = false) {
		const children = target instanceof RBXInstance ? target.Children : target

		for (const child of children) {
			if (child.getProperty("ClassName") === className) {
				return child
			}
		}

		if (recursive) {
			const arrays = [children]

			while (arrays.length) {
				for (const desc of arrays.shift()) {
					if (desc.getProperty("ClassName") === className) {
						return desc
					}

					if (desc.Children.length) {
						arrays.push(desc.Children)
					}
				}
			}
		}

		return null
	}
}

class RBXInstance {
	constructor(className) {
		this.Children = []
		this.Properties = {}
		this.setProperty("ClassName", className, "string")
	}

	setProperty(name, value, type) {
		if (type != null && value == null) throw new Error("type cant be null")
		if (type != null && !RBXDataTypes.includes(type)) throw new Error(`invalid type ${type}`)

		const canSet = name !== "Children" && name !== "Properties" && !(name in Object.getPrototypeOf(this))

		if (type != null) {
			this.Properties[name] = { type, value }
			if (canSet) { this[name] = value }
		} else {
			delete this.Properties[name]
			if (canSet) { delete this[name] }
		}
	}

	getProperty(name, caseInsensitive = false) {
		const property = this.Properties[name] || (caseInsensitive && Object.entries(this.Properties).find(x => x[0].toLowerCase() === name.toLowerCase())?.[1])
		return property ? property.value : undefined
	}

	findFirstChild(name, recursive = false) {
		return RBXInstanceUtils.findFirstChild(this, name, recursive)
	}

	findFirstChildOfClass(className, recursive = false) {
		return RBXInstanceUtils.findFirstChildOfClass(this, className, recursive)
	}
}

// http://www.classy-studios.com/Downloads/RobloxFileSpec.pdf

const RBXBinaryParser = {
	HeaderBytes: [0x3C, 0x72, 0x6F, 0x62, 0x6C, 0x6F, 0x78, 0x21, 0x89, 0xFF, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00],
	Faces: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]],

	parse(buffer, params) {
		const reader = new ByteReader(buffer)

		if (!reader.Match("<roblox")) throw new Error("[RBXBinaryParser] Not a valid RBXM file")
		reader.Match("\x21\x89\xFF\x0D\x0A\x1A\x0A\x00\x00") // header bytes

		const typeCount = reader.UInt32LE()
		const instanceCount = reader.UInt32LE()
		reader.Jump(8)

		const parser = {
			instances: new Array(instanceCount),
			types: new Array(typeCount),
			sharedStrings: [],

			arrays: [],
			arrayIndex: 0,

			result: new RBXInstanceArray(),
			meta: {}
		}

		// preallocate some arrays
		for (let i = 0; i < 10; i++) {
			parser.arrays.push(new Array(256))
		}

		// preallocate a buffer that fits the biggest decompressed chunk
		const chunks = []
		let maxChunkSize = 0

		while (true) {
			const chunkType = reader.String(4)

			const comLength = reader.UInt32LE()
			const decomLength = reader.UInt32LE()
			reader.Jump(4) // reserved

			chunks.push({
				chunkType: chunkType,
				comLength: comLength,
				decomLength: decomLength,
				dataStartIndex: reader.GetIndex()
			})

			if (comLength > 0) {
				if (reader.GetRemaining() < comLength) throw new Error("[RBXBinaryParser] unexpected eof")
				reader.Jump(comLength)

				if (decomLength > maxChunkSize) {
					maxChunkSize = decomLength
				}
			} else {
				if (reader.GetRemaining() < decomLength) throw new Error("[RBXBinaryParser] unexpected eof")
				reader.Jump(decomLength)
			}

			if (chunkType === "END\0") {
				break
			}
		}

		if (reader.GetRemaining() !== 0) {
			console.warn("[RBXBinaryParser] unexpected data after END chunk")
		}

		const chunkBuffer = new Uint8Array(maxChunkSize)

		for (let i = 0; i < chunks.length; i++) {
			const { chunkType, comLength, decomLength, dataStartIndex } = chunks[i]

			let data

			reader.SetIndex(dataStartIndex)

			if (comLength === 0) {
				data = reader.Array(decomLength)

			} else if (reader.PeekUInt32LE() === 0xFD2FB528) {
				data = reader.Zstd(comLength, decomLength, chunkBuffer)

			} else {
				data = reader.LZ4(comLength, decomLength, chunkBuffer)
			}

			const chunkReader = new ByteReader(data)
			parser.arrayIndex = 0 // reset arrays

			switch (chunkType) {
				case "INST":
					this.parseINST(parser, chunkReader)
					break
				case "PROP":
					this.parsePROP(parser, chunkReader)
					break
				case "PRNT":
					this.parsePRNT(parser, chunkReader)
					break
				case "SSTR":
					this.parseSSTR(parser, chunkReader)
					break
				case "META":
					this.parseMETA(parser, chunkReader)
					break
				case "END\0":
					break
				default:
					console.warn(`[RBXBinaryParser] Unknown chunk '${chunkType}'`)
			}
		}

		return parser
	},

	parseMETA(parser, chunk) {
		const count = chunk.UInt32LE()

		for (let i = 0; i < count; i++) {
			const key = chunk.String(chunk.UInt32LE())
			const value = chunk.String(chunk.UInt32LE())
			parser.meta[key] = value
		}

		if (chunk.GetRemaining() !== 0) {
			console.warn("[RBXBinaryParser] META chunk has extra data")
		}
	},

	parseSSTR(parser, chunk) {
		const version = chunk.UInt32LE()

		if (version === 0) {
			const count = chunk.UInt32LE()

			for (let i = 0; i < count; i++) {
				const md5 = chunk.Array(16)
				const length = chunk.UInt32LE()
				const value = chunk.String(length)

				parser.sharedStrings[i] = { md5, value }
			}

			if (chunk.GetRemaining() !== 0) {
				console.warn("[RBXBinaryParser] SSTR chunk has extra data")
			}
		} else {
			console.warn(`[RBXBinaryParser] unknown SSTR version ${version}`)
		}
	},

	parseINST(parser, chunk) {
		const typeId = chunk.UInt32LE()
		const className = chunk.String(chunk.UInt32LE())
		const isService = chunk.UInt8()
		const count = chunk.UInt32LE()

		const type = {
			className: className,
			instances: []
		}

		parser.types[typeId] = type

		const instanceIds = chunk.RBXInterleavedInt32(count, parser.arrays[parser.arrayIndex++])
		let instanceId = 0

		for (let i = 0; i < count; i++) {
			const inst = new RBXInstance(className)
			type.instances.push(inst)

			instanceId += instanceIds[i]
			parser.instances[instanceId] = inst
		}

		if (isService) {
			let valid = false

			if (isService === 1 && chunk.GetRemaining() === count) {
				valid = true

				for (let i = 0; i < count; i++) {
					if (chunk[chunk.index + i] !== 1) {
						valid = false
						break
					}
				}
			}

			if (valid) {
				chunk.Jump(count)
			} else {
				console.warn(`[RBXBinaryParser] INST chunk ${className}(${count}) isService=${isService} has unexpected trailing data`)
			}
		}

		if (chunk.GetRemaining() !== 0) {
			console.warn(`[RBXBinaryParser] INST chunk ${className}(${count}) isService=${isService} has extra data ${chunk.GetRemaining()}`)
		}
	},

	parsePROP(parser, chunk) {
		const type = parser.types[chunk.UInt32LE()]
		const name = chunk.String(chunk.UInt32LE())

		if (chunk.GetRemaining() === 0) throw new Error("[RBXBinaryParser] PROP chunk is empty??")

		const count = type.instances.length
		const parseProperties = (values) => {
			const typeIndex = chunk.UInt8()
			const typeName = RBXDataTypes[typeIndex] || "Unknown"
			let valueType = typeName

			switch (typeName) {
				case "string":
					for (let i = 0; i < count; i++) {
						values[i] = chunk.String(chunk.UInt32LE())
					}
					break
				case "bool":
					for (let i = 0; i < count; i++) {
						values[i] = chunk.UInt8() !== 0
					}
					break
				case "int":
					chunk.RBXInterleavedInt32(count, values)
					break
				case "float":
					chunk.RBXInterleavedFloat(count, values)
					break
				case "double":
					for (let i = 0; i < count; i++) {
						values[i] = chunk.DoubleLE()
					}
					break
				case "UDim": {
					const scale = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const offset = chunk.RBXInterleavedInt32(count, parser.arrays[parser.arrayIndex++])
					for (let i = 0; i < count; i++) {
						values[i] = [scale[i], offset[i]]
					}
					break
				}
				case "UDim2": {
					const scaleX = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const scaleY = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const offsetX = chunk.RBXInterleavedInt32(count, parser.arrays[parser.arrayIndex++])
					const offsetY = chunk.RBXInterleavedInt32(count, parser.arrays[parser.arrayIndex++])
					for (let i = 0; i < count; i++) {
						values[i] = [
							[scaleX[i], offsetX[i]],
							[scaleY[i], offsetY[i]]
						]
					}
					break
				}
				case "Ray": {
					for (let i = 0; i < count; i++) {
						values[i] = [
							[chunk.FloatLE(), chunk.FloatLE(), chunk.FloatLE()],
							[chunk.FloatLE(), chunk.FloatLE(), chunk.FloatLE()]
						]
					}
					break
				}
				case "Faces":
					for (let i = 0; i < count; i++) {
						const data = chunk.UInt8()

						values[i] = {
							Right: !!(data & 1),
							Top: !!(data & 2),
							Back: !!(data & 4),
							Left: !!(data & 8),
							Bottom: !!(data & 16),
							Front: !!(data & 32)
						}
					}
					break
				case "Axes":
					for (let i = 0; i < count; i++) {
						const data = chunk.UInt8()

						values[i] = {
							X: !!(data & 1),
							Y: !!(data & 2),
							Z: !!(data & 4)
						}
					}
					break
				case "BrickColor":
					chunk.RBXInterleavedUInt32(count, values)
					break
				case "Color3": {
					const r = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const g = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const b = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])

					for (let i = 0; i < count; i++) {
						values[i] = [r[i], g[i], b[i]]
					}
					break
				}
				case "Vector2": {
					const vecX = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const vecY = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					for (let i = 0; i < count; i++) {
						values[i] = [vecX[i], vecY[i]]
					}
					break
				}
				case "Vector3": {
					const vecX = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const vecY = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const vecZ = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					for (let i = 0; i < count; i++) {
						values[i] = [vecX[i], vecY[i], vecZ[i]]
					}
					break
				}
				case "Vector2int16": {
					const vecX = chunk.RBXInterleavedUInt16(count, parser.arrays[parser.arrayIndex++])
					const vecY = chunk.RBXInterleavedUInt16(count, parser.arrays[parser.arrayIndex++])

					const int16be = (x) => ((x << 8 | x >>> 8) & 0x7FFF) - ((x << 8) & 0x8000)

					for (let i = 0; i < count; i++) {
						values[i] = [int16be(vecX[i]), int16be(vecY[i])]
					}
					break
				}
				case "Vector3int16": {
					const vecX = chunk.RBXInterleavedUInt16(count, parser.arrays[parser.arrayIndex++])
					const vecY = chunk.RBXInterleavedUInt16(count, parser.arrays[parser.arrayIndex++])
					const vecZ = chunk.RBXInterleavedUInt16(count, parser.arrays[parser.arrayIndex++])

					const int16be = (x) => ((x << 8 | x >>> 8) & 0x7FFF) - ((x << 8) & 0x8000)

					for (let i = 0; i < count; i++) {
						values[i] = [int16be(vecX[i]), int16be(vecY[i]), int16be(vecZ[i])]
					}
					break
				}
				case "CFrame": {
					for (let vi = 0; vi < count; vi++) {
						const value = values[vi] = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
						const type = chunk.UInt8()

						if (type !== 0) {
							const right = RBXBinaryParser.Faces[Math.floor((type - 1) / 6)]
							const up = RBXBinaryParser.Faces[Math.floor(type - 1) % 6]
							const back = [
								right[1] * up[2] - up[1] * right[2],
								right[2] * up[0] - up[2] * right[0],
								right[0] * up[1] - up[0] * right[1]
							]

							for (let i = 0; i < 3; i++) {
								value[3 + i * 3] = right[i]
								value[4 + i * 3] = up[i]
								value[5 + i * 3] = back[i]
							}
						} else {
							for (let i = 3; i < 12; i++) {
								value[i] = chunk.FloatLE()
							}
						}
					}

					const vecX = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const vecY = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const vecZ = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					for (let i = 0; i < count; i++) {
						values[i][0] = vecX[i]
						values[i][1] = vecY[i]
						values[i][2] = vecZ[i]
					}
					break
				}
				case "Enum":
					chunk.RBXInterleavedUInt32(count, values)
					break
				case "Instance": {
					const refIds = chunk.RBXInterleavedInt32(count, parser.arrays[parser.arrayIndex++])

					let refId = 0
					for (let i = 0; i < count; i++) {
						refId += refIds[i]
						values[i] = parser.instances[refId]
					}
					break
				}
				case "NumberSequence": {
					for (let i = 0; i < count; i++) {
						const length = chunk.UInt32LE()
						const sequence = []

						for (let j = 0; j < length; j++) {
							sequence.push({
								Time: chunk.FloatLE(),
								Value: chunk.FloatLE(),
								Envelope: chunk.FloatLE()
							})
						}

						values[i] = sequence
					}
					break
				}
				case "ColorSequence":
					for (let i = 0; i < count; i++) {
						const length = chunk.UInt32LE()
						const sequence = []

						for (let j = 0; j < length; j++) {
							sequence.push({
								Time: chunk.FloatLE(),
								Value: [chunk.FloatLE(), chunk.FloatLE(), chunk.FloatLE()]
							})

							chunk.FloatLE() // unused (envelope?)
						}

						values[i] = sequence
					}
					break
				case "NumberRange":
					for (let i = 0; i < count; i++) {
						values[i] = [chunk.FloatLE(), chunk.FloatLE()]
					}
					break
				case "Rect2D": {
					const x0 = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const y0 = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const x1 = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
					const y1 = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])

					for (let i = 0; i < count; i++) {
						values[i] = [[x0[i], y0[i]], [x1[i], y1[i]]]
					}
					break
				}
				case "PhysicalProperties":
					for (let i = 0; i < count; i++) {
						const byte = chunk.UInt8()

						if (byte === 0 || byte === 2) {
							values[i] = false

						} else if (byte === 1 || byte === 3) {
							values[i] = {
								Density: chunk.FloatLE(),
								Friction: chunk.FloatLE(),
								Elasticity: chunk.FloatLE(),
								FrictionWeight: chunk.FloatLE(),
								ElasticityWeight: chunk.FloatLE(),
								AcousticAbsorption: byte & 2 ? chunk.FloatLE() : 1
							}

						} else {
							console.warn(`[RBXBinaryParser] Unknown PhysicalProperties format ${byte}`)
							values[i] = false
						}
					}
					break
				case "Color3uint8": {
					const rgbs = chunk.Array(count * 3)

					for (let i = 0; i < count; i++) {
						const rgb = rgbs
						values[i] = [rgb[i] / 255, rgb[i + count] / 255, rgb[i + count * 2] / 255]
					}

					valueType = "Color3"
					break
				}
				case "Font":
					for (let i = 0; i < count; i++) {
						values[i] = {
							Family: chunk.String(chunk.UInt32LE()),
							Weight: chunk.UInt16LE(),
							Style: chunk.UInt8(),
							CachedFaceId: chunk.String(chunk.UInt32LE())
						}
					}
					break
				case "int64":
					chunk.RBXInterleavedInt64(count, values)
					break
				case "SecurityCapabilities":
					chunk.RBXInterleavedInt64(count, values)

					for (let i = 0; i < count; i++) {
						const value = values[i]

						values[i] = {
							RunClientScript: (value & 256n) !== 0n,
							RunServerScript: (value & 512n) !== 0n,
							AccessOutsideWrite: (value & 2048n) !== 0n,
							AssetRequire: (value & 65536n) !== 0n,
							LoadString: (value & 131072n) !== 0n,
							ScriptGlobals: (value & 262144n) !== 0n,
							CreateInstances: (value & 524288n) !== 0n,
							Basic: (value & 1048576n) !== 0n,
							Audio: (value & 2097152n) !== 0n,
							DataStore: (value & 4194304n) !== 0n,
							Network: (value & 8388608n) !== 0n,
							Physics: (value & 16777216n) !== 0n,
							UI: (value & 33554432n) !== 0n,
							CSG: (value & 67108864n) !== 0n,
							Chat: (value & 134217728n) !== 0n,
							Animation: (value & 268435456n) !== 0n,
							Avatar: (value & 536870912n) !== 0n,
							Input: (value & 1073741824n) !== 0n,
							Environment: (value & 2147483648n) !== 0n,
							RemoteEvent: (value & 4294967296n) !== 0n,
							LegacySound: (value & 8589934592n) !== 0n,
							Players: (value & 17179869184n) !== 0n,
							CapabilityControl: (value & 34359738368n) !== 0n,
						}
					}

					break
				case "SharedString":
					chunk.RBXInterleavedUInt32(count, values)
					for (let i = 0; i < count; i++) {
						values[i] = parser.sharedStrings[values[i]].value
					}
					valueType = "string"
					break
				case "Optional": {
					[, valueType] = parseProperties(values)

					const [mask] = parseProperties(parser.arrays[parser.arrayIndex++])

					for (let i = 0; i < count; i++) {
						if (!mask[i]) {
							values[i] = null
						}
					}
					break
				}
				case "UniqueId": {
					const bytes = chunk.Array(count * 16)

					for (let i = 0; i < count; i++) {
						let result = ""

						for (let j = 0; j < 16; j++) {
							const byte = bytes[j * count + i]
							result += ("0" + byte.toString(16)).slice(-2)
						}

						values[i] = result
					}
					break
				}
				case "Content": {
					const sourceTypes = chunk.RBXInterleavedInt32(count, parser.arrays[parser.arrayIndex++])

					const numUris = chunk.UInt32LE()
					const uris = parser.arrays[parser.arrayIndex++]

					for (let i = 0; i < numUris; i++) {
						uris[i] = chunk.String(chunk.UInt32LE())
					}

					const numObjects = chunk.UInt32LE()
					const objects = chunk.RBXInterleavedInt32(numObjects, parser.arrays[parser.arrayIndex++])

					const numObjectsExternal = chunk.UInt32LE()
					const objectsExternal = chunk.RBXInterleavedInt32(numObjectsExternal, parser.arrays[parser.arrayIndex++])

					let uriCounter = 0
					let objectIndex = 0
					let objectRef = 0

					for (let i = 0; i < count; i++) {
						const sourceType = sourceTypes[i]

						if (sourceType === 1) {
							values[i] = {
								SourceType: sourceType,
								Uri: uris[uriCounter++]
							}

						} else if (sourceType === 2) {
							objectRef += objects[objectIndex++]

							values[i] = {
								SourceType: sourceType,
								Object: objectRef
							}

						} else {
							values[i] = {
								SourceType: sourceType
							}
						}
					}

					break
				}
			case "Quaternion": {
				const qX = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
				const qY = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
				const qZ = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
				const qW = chunk.RBXInterleavedFloat(count, parser.arrays[parser.arrayIndex++])
				for (let i = 0; i < count; i++) {
					values[i] = [qX[i], qY[i], qZ[i], qW[i]]
				}
				break
			}
			default:
					if (!typeName) {
						console.warn(`[RBXBinaryParser] Unknown dataType for ${type.className}.${name}`)
					} else {
						console.warn(`[RBXBinaryParser] Unimplemented dataType ${typeIndex} '${typeName}' for ${type.className}.${name}`)
					}

					for (let i = 0; i < count; i++) {
						values[i] = `<${typeName}>`
					}
					break
			}

			return [values, valueType]
		}

		const [values, valueType] = parseProperties(parser.arrays[parser.arrayIndex++])

		for (let i = 0; i < count; i++) {
			const inst = type.instances[i]
			const value = values[i]

			if (value != null) {
				inst.setProperty(name, value, valueType)
			}
		}

		if (chunk.GetRemaining() !== 0) {
			console.warn(`[RBXBinaryParser] PROP ${type.className}.${name}(${count}) valueType=${valueType} has extra data ${chunk.GetRemaining()}`)
		}
	},

	parsePRNT(parser, chunk) {
		chunk.UInt8()
		const count = chunk.UInt32LE()

		const childIds = chunk.RBXInterleavedInt32(count, parser.arrays[parser.arrayIndex++])
		const parentIds = chunk.RBXInterleavedInt32(count, parser.arrays[parser.arrayIndex++])

		let childId = 0
		let parentId = 0
		for (let i = 0; i < count; i++) {
			childId += childIds[i]
			parentId += parentIds[i]

			const child = parser.instances[childId]
			if (parentId >= 0) {
				const parent = parser.instances[parentId]

				child.setProperty("Parent", parent, "Instance")
				parent.Children.push(child)
			} else {
				parser.result.push(child)
			}
		}

		if (chunk.GetRemaining() !== 0) {
			console.warn("[RBXBinaryParser] PRNT chunk has extra data")
		}
	}
}

const RBXXMLParser = {
	parse(buffer) {
		const text = bufferToString(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
		const xml = text.replace(/^\uFEFF/, "")
		const roots = this.parseXML(xml)
		const root = roots.find(node => node.name.toLowerCase() === "roblox")

		if (!root) throw new Error("[RBXXMLParser] Missing <roblox> root element")

		const parser = {
			instances: new Map(),
			result: new RBXInstanceArray(),
			meta: {}
		}

		const itemRecords = []

		const createInstanceTree = (itemNode, parent) => {
			const className = itemNode.attrs.class || itemNode.attrs.Class || "Instance"
			const referent = itemNode.attrs.referent || itemNode.attrs.Referent || `__anonymous_${itemRecords.length}`
			const inst = new RBXInstance(className)

			parser.instances.set(referent, inst)
			itemRecords.push({ node: itemNode, inst })

			if (parent) {
				inst.setProperty("Parent", parent, "Instance")
				parent.Children.push(inst)
			} else {
				parser.result.push(inst)
			}

			for (const child of itemNode.children) {
				if (child.name.toLowerCase() === "item") {
					createInstanceTree(child, inst)
				}
			}
		}

		for (const child of root.children) {
			if (child.name.toLowerCase() === "item") {
				createInstanceTree(child, null)
			} else if (child.name.toLowerCase() === "meta") {
				this.parseMETA(child, parser)
			}
		}

		for (const { node, inst } of itemRecords) {
			const properties = this.childByName(node, "Properties")
			if (properties) this.parseProperties(properties, inst, parser)
		}

		return parser
	},

	parseXML(xml) {
		const roots = []
		const stack = []
		const tokenRegex = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/[^>]+>|<[^>]+>|[^<]+/g
		let match

		while ((match = tokenRegex.exec(xml)) !== null) {
			const token = match[0]

			if (!token || token.startsWith("<?") || token.startsWith("<!--") || token.startsWith("<!DOCTYPE") || token.startsWith("<!doctype")) {
				continue
			}

			if (token.startsWith("<![CDATA[")) {
				if (stack.length) stack[stack.length - 1].text += token.slice(9, -3)
				continue
			}

			if (token[0] !== "<") {
				if (stack.length) stack[stack.length - 1].text += this.decodeEntities(token)
				continue
			}

			if (token.startsWith("</")) {
				const name = token.slice(2, -1).trim()
				const node = stack.pop()
				if (!node || node.name !== name) throw new Error(`[RBXXMLParser] Unbalanced closing tag ${name}`)
				continue
			}

			const selfClosing = /\/\s*>$/.test(token)
			const tagMatch = token.match(/^<\s*([^\s/>]+)([\s\S]*?)(?:\/\s*)?>$/)
			if (!tagMatch) continue

			const node = {
				name: tagMatch[1],
				attrs: this.parseAttributes(tagMatch[2]),
				children: [],
				text: ""
			}

			if (stack.length) {
				stack[stack.length - 1].children.push(node)
			} else {
				roots.push(node)
			}

			if (!selfClosing) stack.push(node)
		}

		if (stack.length) throw new Error(`[RBXXMLParser] Unclosed <${stack[stack.length - 1].name}> element`)
		return roots
	},

	parseAttributes(raw) {
		const attrs = {}
		const attrRegex = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
		let match

		while ((match = attrRegex.exec(raw)) !== null) {
			attrs[match[1]] = this.decodeEntities(match[2] ?? match[3] ?? match[4] ?? "")
		}

		return attrs
	},

	parseMETA(node, parser) {
		for (const child of node.children) {
			const key = child.attrs.name || child.attrs.key || child.name
			parser.meta[key] = this.nodeText(child).trim()
		}
	},

	parseProperties(propertiesNode, inst, parser) {
		for (const propNode of propertiesNode.children) {
			const name = propNode.attrs.name
			if (!name) continue

			const typeName = this.normalizeType(propNode.name)
			if (!RBXDataTypes.includes(typeName)) {
				console.warn(`[RBXXMLParser] Unimplemented dataType '${propNode.name}' for ${inst.getProperty("ClassName")}.${name}`)
				continue
			}

			const value = this.parseValue(typeName, propNode, parser)
			if (value !== undefined && value !== null) {
				inst.setProperty(name, value, typeName)
			}
		}
	},

	normalizeType(typeName) {
		switch (typeName) {
			case "CoordinateFrame":
				return "CFrame"
			case "ProtectedString":
			case "SharedString":
				return "string"
			case "token":
				return "Enum"
			case "BinaryString":
				return "string"
			default:
				return typeName
		}
	},

	parseValue(typeName, node, parser) {
		const raw = this.nodeText(node).trim()
		const numberList = () => raw.split(/[,\s]+/).filter(Boolean).map(Number)
		const num = (name, fallback = 0) => {
			const child = this.childByName(node, name)
			if (child) {
				const value = Number(this.nodeText(child).trim())
				return Number.isFinite(value) ? value : fallback
			}
			const attr = node.attrs[name]
			if (attr != null) {
				const value = Number(attr)
				return Number.isFinite(value) ? value : fallback
			}
			return fallback
		}

		switch (typeName) {
			case "string":
				return raw
			case "bool":
				return raw.toLowerCase() === "true"
			case "int":
			case "Enum":
			case "BrickColor":
				return Number(raw)
			case "int64":
				return raw ? BigInt(raw) : 0n
			case "float":
			case "double":
				return Number(raw)
			case "UDim":
				return node.children.length ? [num("S"), num("O")] : numberList()
			case "UDim2":
				return node.children.length ? [[num("XS"), num("XO")], [num("YS"), num("YO")]] : [[numberList()[0], numberList()[1]], [numberList()[2], numberList()[3]]]
			case "Ray": {
				const values = numberList()
				return [[values[0], values[1], values[2]], [values[3], values[4], values[5]]]
			}
			case "Faces":
			case "Axes": {
				const result = {}
				for (const child of node.children) {
					result[child.name] = this.nodeText(child).trim().toLowerCase() === "true"
				}
				return result
			}
			case "Color3":
				return node.children.length ? [num("R"), num("G"), num("B")] : numberList()
			case "Color3uint8":
				return node.children.length ? [num("R") / 255, num("G") / 255, num("B") / 255] : numberList().map(x => x / 255)
			case "Vector2":
			case "Vector2int16":
				return node.children.length ? [num("X"), num("Y")] : numberList()
			case "Vector3":
			case "Vector3int16":
				return node.children.length ? [num("X"), num("Y"), num("Z")] : numberList()
			case "CFrame":
				return node.children.length ? [
					num("X"), num("Y"), num("Z"),
					num("R00", 1), num("R01"), num("R02"),
					num("R10"), num("R11", 1), num("R12"),
					num("R20"), num("R21"), num("R22", 1)
				] : numberList()
			case "Quaternion":
				return numberList()
			case "Instance": {
				const refNode = this.childByName(node, "Ref")
				const ref = (refNode ? this.nodeText(refNode) : raw).trim()
				if (!ref || ref === "null" || ref === "nil") return null
				return parser.instances.get(ref) || null
			}
			case "NumberRange":
				return node.children.length ? [num("Min"), num("Max")] : numberList()
			case "Rect2D": {
				const values = numberList()
				return [[values[0], values[1]], [values[2], values[3]]]
			}
			case "NumberSequence":
			case "ColorSequence":
				return this.parseSequence(typeName, node, raw)
			case "PhysicalProperties":
				return this.parsePhysicalProperties(node, raw)
			case "Font":
			case "SecurityCapabilities":
			case "Content":
				return node.children.length ? this.nodeObject(node) : raw
			case "Optional":
				return raw === "" ? null : raw
			case "UniqueId":
				return raw
			default:
				return raw
		}
	},

	parseSequence(typeName, node, raw) {
		const keypoints = node.children.filter(child => child.name.toLowerCase().includes("keypoint"))

		if (keypoints.length) {
			return keypoints.map(child => {
				if (typeName === "ColorSequence") {
					return { Time: this.childNumber(child, "Time"), Value: [this.childNumber(child, "R"), this.childNumber(child, "G"), this.childNumber(child, "B")] }
				}
				return { Time: this.childNumber(child, "Time"), Value: this.childNumber(child, "Value"), Envelope: this.childNumber(child, "Envelope") }
			})
		}

		return raw.split(";").filter(Boolean).map(kp => {
			const parts = kp.split(/[,\s]+/).filter(Boolean).map(Number)
			if (typeName === "ColorSequence") return { Time: parts[0], Value: [parts[1], parts[2], parts[3]] }
			return { Time: parts[0], Value: parts[1], Envelope: parts[2] }
		})
	},

	parsePhysicalProperties(node, raw) {
		if (!node.children.length) return raw ? JSON.parse(raw) : false

		return {
			Density: this.childNumber(node, "Density"),
			Friction: this.childNumber(node, "Friction"),
			Elasticity: this.childNumber(node, "Elasticity"),
			FrictionWeight: this.childNumber(node, "FrictionWeight"),
			ElasticityWeight: this.childNumber(node, "ElasticityWeight"),
			AcousticAbsorption: this.childNumber(node, "AcousticAbsorption", 1)
		}
	},

	childByName(node, name) {
		const lower = name.toLowerCase()
		return node.children.find(child => child.name.toLowerCase() === lower)
	},

	childNumber(node, name, fallback = 0) {
		const child = this.childByName(node, name)
		if (!child) return fallback
		const value = Number(this.nodeText(child).trim())
		return Number.isFinite(value) ? value : fallback
	},

	nodeObject(node) {
		const result = {}
		for (const child of node.children) {
			result[child.name] = child.children.length ? this.nodeObject(child) : this.nodeText(child).trim()
		}
		return result
	},

	nodeText(node) {
		let result = node.text || ""
		for (const child of node.children) {
			result += this.nodeText(child)
		}
		return result
	},

	decodeEntities(text) {
		return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity) => {
			switch (entity) {
				case "amp": return "&"
				case "lt": return "<"
				case "gt": return ">"
				case "quot": return "\""
				case "apos": return "'"
				default:
					return entity[1] === "x"
						? String.fromCodePoint(parseInt(entity.slice(2), 16))
						: String.fromCodePoint(parseInt(entity.slice(1), 10))
			}
		})
	}
}

const RBXModelParser = {
	parse(buffer, params) {
		const reader = new ByteReader(buffer)
		if (reader.String(7) !== "<roblox") throw new Error("Not a valid RBXM file")

		if (reader.Byte() === 0x21) {
			return RBXBinaryParser.parse(buffer, params)
		}

		// XML format — re-parse from start (we consumed 8 bytes to check format)
		return RBXXMLParser.parse(buffer)
	}
}

// JSON-safe replacer to handle BigInt
function jsonReplacer(key, value) {
	if (typeof value === "bigint") {
		return value.toString()
	}
	return value
}

export { RBXModelParser, RBXInstance, RBXInstanceArray, jsonReplacer }
