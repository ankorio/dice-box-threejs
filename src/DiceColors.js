import {TEXTURELIST} from "./const/texturelist"
import {COLORSETS} from "./const/colorsets"

export class DiceColors {
	
	constructor(options = {}) {
		this.colorsets = []
		this.assetPath = options.assetPath
	}

	async ImageLoader(data) {

		if (Array.isArray(data)) {
			for(let i = 0, l = data.length; i < l; i++){
				data[i] = await this.ImageLoader(data[i])
			}
			return data
		}
		
		if (data.source && data.source != '') {
			data.texture = await this.loadImage(data.source)
		}
		
		if (data.source_bump && data.source_bump != '') {
			data.bump = await this.loadImage(data.source_bump)
		}

		return data
	}

	loadImage(src){
		return new Promise((resolve, reject) => {
			let img = new Image()
			img.onload = () => resolve(img)
			img.crossOrigin = "anonymous";
			img.src = this.assetPath + src
			img.onerror = (error) => reject(error)
			}).catch(e => {
				console.error("Unable to load image texture")
				// throw new Error("Unable to load image")
			})
	}

	// randomColor() {
	// 	// random colors
	// 	let rgb=[];
	// 	rgb[0] = Math.floor(Math.random() * 254);
	// 	rgb[1] = Math.floor(Math.random() * 254);
	// 	rgb[2] = Math.floor(Math.random() * 254);
		
	// 	// this is an attempt to make the foregroudn color stand out from the background color
	// 	// it sometimes produces ok results
	// 	let brightness = ((parseInt(rgb[0]) * 299) + (parseInt(rgb[1]) * 587) +  (parseInt(rgb[2]) * 114)) / 1000;
	// 	let foreground = (brightness > 126) ? 'rgb(30,30,30)' : 'rgb(230,230,230)'; // high brightness = dark text, else bright text
	// 	let background = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
		
	// 	return {background: background, foreground: foreground };
	// }
	
	async getColorSet(options) {
		let setName, texture, material
		if(typeof options === "string") {
			setName = options
		}
		if(typeof options === "object") {
			setName = options.colorset
			texture = options.texture
			material = options.material
		}

		const base = COLORSETS[setName] || COLORSETS["white"]
		texture = texture || base.texture

		// Cache by colorset + texture + material, not just the colorset name — the
		// same palette (e.g. "white") is used with many different textures/materials
		// across concurrent rolls, and keying by name alone returned the wrong look.
		const texKey = Array.isArray(texture) ? texture.join(',') : texture
		const cacheKey = `${setName}|${texKey}|${material || ''}`
		if(this.colorsets.hasOwnProperty(cacheKey)) {
			return this.colorsets[cacheKey]
		}

		// Clone so we never mutate the shared COLORSETS entry (it would corrupt every
		// other roll that reuses this palette with a different texture/material).
		let colorset = Object.assign({}, base)

		// get texture data + load images
		colorset.texture = await this.ImageLoader(this.getTexture(texture))

		// if material type was specified then use it (clone the texture object first so
		// the override doesn't leak onto the shared TEXTURELIST entry)
		if(material && !Array.isArray(colorset.texture)) {
			colorset.texture = Object.assign({}, colorset.texture)
			colorset.texture.material = material
		}

		// save it for later
		this.colorsets[cacheKey] = colorset

		return colorset;
	}

	async makeColorSet(options = {}){
		if(this.colorsets.hasOwnProperty(options.name)) {
			return this.colorsets[options.name]
		}

		let defaultSet = COLORSETS["white"]
		let colorset = Object.assign({},defaultSet,options)
		// get texture data
		let texture = this.getTexture(colorset.texture)

		// load textures
		colorset.texture = await this.ImageLoader(texture)

		if(options.material && !Array.isArray(colorset.texture)) {
			// clone first so the material override doesn't leak onto the shared TEXTURELIST entry
			colorset.texture = Object.assign({}, colorset.texture)
			colorset.texture.material = options.material
		}

		if(colorset.name.toLowerCase() === "white"){
			// create a unique name
			colorset.name = `${Date.now()}`
		}

		// save it for later
		this.colorsets[colorset.name] = colorset

		return colorset
	}
	
	getTexture(texturename) {
		if (Array.isArray(texturename)) {
			let textures = [];
			for(let i = 0, l = texturename.length; i < l; i++){
				textures.push(this.getTexture(texturename[i]));
			}
			return textures;
		}
		
		if (TEXTURELIST.hasOwnProperty(texturename)) {
			return TEXTURELIST[texturename]
		}
		return TEXTURELIST['none']
	}

}