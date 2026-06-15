import * as THREE from "three"
import * as CANNON from "cannon-es"

import { DiceNotation } from './DiceNotation.js';
import { DiceFactory } from './DiceFactory.js';
import { DiceColors } from './DiceColors.js';
import { THEMES } from './const/themes.js';
// import CannonDebugger from 'cannon-es-debugger'

import { debounce } from "./helpers"

const defaultConfig = {
	assetPath: "./",
	framerate: (1/60),
	sounds: false,
	volume: 100,
	color_spotlight: 0xefdfd5,
	shadows: true,
	theme_surface:  "green-felt",
	sound_dieMaterial: 'plastic',
	theme_customColorset: null,
	theme_colorset: "white",
	theme_texture: "",
	theme_material: "glass",
	gravity_multiplier: 400,
	light_intensity: 0.7,
	baseScale: 100,
	strength: 1,
	iterationLimit: 1000,
	continuousRender: false,
	onRollComplete: () => {},
	onRerollComplete: () => {},
	onAddDiceComplete: () => {},
	onRemoveDiceComplete: () => {},
}

class DiceBox {

	constructor(element_container, options = {}) {
		//private variables
		this.initialized = false
		this.container = document.querySelector(element_container);
		this.dimensions = new THREE.Vector2(this.container.clientWidth, this.container.clientHeight)
		this.adaptive_timestep = false;
		this.last_time = 0;
		this.running = false;
		this.rolling = false;
		this.threadid;

		this.display = {
			currentWidth: null,
			currentHeight: null,
			containerWidth: null,
			containerHeight: null,
			aspect: null,
			scale: null
		};

		this.cameraHeight = {
			max: null,
			close: null,
			medium: null,
			far: null
		};

		this.scene = new THREE.Scene();
		this.world = new CANNON.World();
		this.dice_body_material = new CANNON.Material();
		this.sounds_table = {};
		this.sounds_dice = [];
		this.lastSoundType = '';
		this.lastSoundStep = 0;
		this.lastSound = 0;
		this.iteration;
		this.renderer;
		this.barrier;
		this.camera;
		this.light;
		this.light_amb;
		this.desk;
		this.box_body = {};
		this.bodies = [];
		this.meshes = [];
		this.diceList = [];
		this.notationVectors = null
		this.dieIndex = 0

		// Concurrent roll groups. Each independent throw (keyed by an app-supplied
		// groupId) coexists in the same scene/physics world with its own dice, theme,
		// entry side, settle detection and completion promise. See rollGroup().
		this.groups = new Map()
		this._addCounter = 0
		this._lastStepTime = 0

		// VFX integration hooks (additive, backward-compatible).
		// External particle systems register per-frame callbacks here; the
		// continuous loop keeps drawing while dice are idle (looping auras).
		this._beforeRenderCallbacks = [];
		this._afterRenderCallbacks = [];
		this._lastRenderTime = 0;
		this._continuousRunning = false;
		this._continuousRAF = null;

		//public variables
		// this.framerate = (1/60);
		// this.sounds = false;
		// this.volume = 100;
		// this.theme_surface = "green-felt"
		// this.sound_dieMaterial = 'plastic'
		this.soundDelay = 10; // time between sound effects in ms
		this.animstate = '';
		// this.tally = true;


		this.selector = {
			animate: true,
			rotate: true,
			intersected: null,
			dice: []
		};

		// this.colors = {
		// 	ambient:  0xf0f5fb,
		// 	spotlight: 0xefdfd5
		// };

		// this.shadows = true

		// merge this with default config and any options coming in
		Object.assign(this, defaultConfig, options)

		this.DiceColors = new DiceColors({assetPath: this.assetPath});
		this.DiceFactory = new DiceFactory({
			baseScale: this.baseScale
		});
		this.DiceFactory.setBumpMapping(true);

		// post config settings
		this.surface = THEMES[this.theme_surface].surface

	}


	enableShadows(){
		this.shadows = true;
		if (this.renderer) this.renderer.shadowMap.enabled = this.shadows;
		if (this.light) this.light.castShadow = this.shadows;
		if (this.desk) this.desk.receiveShadow = this.shadows;
	}
	disableShadows() {
		this.shadows = false;
		if (this.renderer) this.renderer.shadowMap.enabled = this.shadows;
		if (this.light) this.light.castShadow = this.shadows;
		if (this.desk) this.desk.receiveShadow = this.shadows;
	}

	// --- VFX integration hooks (additive, upstreamable) ---

	// Register a callback invoked each rendered frame, before the draw call,
	// with a delta-time in seconds. Returns an unsubscribe function.
	onBeforeRender(cb) {
		if (typeof cb === 'function' && !this._beforeRenderCallbacks.includes(cb)) {
			this._beforeRenderCallbacks.push(cb);
		}
		return () => this.offBeforeRender(cb);
	}

	offBeforeRender(cb) {
		const i = this._beforeRenderCallbacks.indexOf(cb);
		if (i !== -1) this._beforeRenderCallbacks.splice(i, 1);
	}

	// Register a callback invoked each rendered frame, after the draw call.
	// Returns an unsubscribe function.
	onAfterRender(cb) {
		if (typeof cb === 'function' && !this._afterRenderCallbacks.includes(cb)) {
			this._afterRenderCallbacks.push(cb);
		}
		return () => this.offAfterRender(cb);
	}

	offAfterRender(cb) {
		const i = this._afterRenderCallbacks.indexOf(cb);
		if (i !== -1) this._afterRenderCallbacks.splice(i, 1);
	}

	// Draw one frame, firing before/after callbacks with a delta-time (seconds)
	// so external particle systems can advance their lifecycles. With no
	// callbacks registered this is equivalent to the old renderer.render() call.
	render() {
		const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
		let dt = this._lastRenderTime ? (now - this._lastRenderTime) / 1000 : 0;
		this._lastRenderTime = now;
		// clamp after long idle gaps (first frame, tab hidden, between rolls)
		if (dt > 0.1) dt = 0.1;

		for (let i = 0; i < this._beforeRenderCallbacks.length; i++) {
			this._beforeRenderCallbacks[i](dt);
		}

		this.renderer.render(this.scene, this.camera);

		for (let i = 0; i < this._afterRenderCallbacks.length; i++) {
			this._afterRenderCallbacks[i](dt);
		}
	}

	// The single persistent loop. It owns physics stepping AND rendering for the
	// whole box: every frame it advances the shared world (only while some group is
	// animating), syncs meshes to their bodies, runs per-group settle detection, and
	// renders once (so VFX onBeforeRender callbacks keep firing even when idle).
	// This replaces the old per-roll animateThrow loop + its this.running thread-id.
	start() {
		if (this._continuousRunning) return;
		this._continuousRunning = true;
		this._lastRenderTime = 0;
		this._lastStepTime = 0;
		const loop = () => {
			if (!this._continuousRunning) return;
			this.stepAndRender();
			this._continuousRAF = requestAnimationFrame(loop);
		};
		this._continuousRAF = requestAnimationFrame(loop);
	}

	stop() {
		this._continuousRunning = false;
		if (this._continuousRAF != null) {
			cancelAnimationFrame(this._continuousRAF);
			this._continuousRAF = null;
		}
	}

	hasAnimatingGroup() {
		for (const group of this.groups.values()) {
			if (group.state === 'animating') return true;
		}
		return false;
	}

	stepAndRender() {
		const animating = this.hasAnimatingGroup();
		this.rolling = animating;

		if (animating) {
			const time = Date.now();
			if (!this._lastStepTime) this._lastStepTime = time - (this.framerate * 1000);
			let time_diff = (time - this._lastStepTime) / 1000;
			// Step enough to track real time so the sim never crawls when rAF is
			// throttled (frame drops, an unrendered OBS source). Cap only to avoid a
			// pathological teleport after a very long stall (rollGroup resets the clock
			// at throw start, so this isn't hit on a fresh roll).
			if (time_diff > 0.5) time_diff = 0.5;
			const neededSteps = Math.max(1, Math.floor(time_diff / this.framerate));

			this.animstate = 'throw';
			for (let i = 0; i < neededSteps; i++) {
				this.world.step(this.framerate);
			}
			this._lastStepTime = this._lastStepTime + neededSteps * this.framerate * 1000;

			// sync every body-bearing scene child to its physics body
			for (let i in this.scene.children) {
				let interact = this.scene.children[i];
				if (interact.body != undefined) {
					interact.position.copy(interact.body.position);
					interact.quaternion.copy(interact.body.quaternion);
				}
			}

			// per-group settle detection — scoped to each group's own dice
			for (const group of this.groups.values()) {
				if (group.state !== 'animating') continue;
				group.iteration += neededSteps;
				if (this.groupFinished(group)) this.finalizeGroup(group);
			}

			// dice moved this frame → refresh the (on-demand) shadow map
			if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
		} else {
			// idle: keep the step clock current so the next group starts cleanly
			this._lastStepTime = Date.now();
		}

		this.render();
	}

	finalizeGroup(group) {
		if (group.state !== 'animating') return;
		group.state = 'settled';
		group.settled = true;
		const results = this.buildResults(group.notationVectors, group.meshes);
		const waiters = group.waiters;
		group.waiters = [];
		for (const resolve of waiters) { try { resolve(results); } catch (e) {} }
		document.dispatchEvent(new CustomEvent('groupComplete', { detail: { groupId: group.groupId, results } }));
	}

	async initialize() {

		// this.cannonDebugger = new CannonDebugger(this.scene,this.world)
		this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
		this.container.appendChild(this.renderer.domElement);
		this.renderer.shadowMap.enabled = this.shadows;
		// VSM (variance) shadows render a Gaussian-blurred penumbra → smooth, soft,
		// never stair-stepped (PCF on a spotlight over this big frustum pixelated as
		// the dice spread out). The softness gives the "faded" contact-shadow look.
		this.renderer.shadowMap.type = THREE.VSMShadowMap;
		// The render loop runs every frame (for VFX), but dice shadows only change
		// while dice move — re-render the (blurred, higher-res) shadow map on demand
		// instead of every idle frame. We flag it dirty whenever dice move/appear/leave.
		this.renderer.shadowMap.autoUpdate = false;
		this.renderer.shadowMap.needsUpdate = true;
		this.renderer.setClearColor(0x000000, 0);

		this.setDimensions(this.dimensions);

		this.world.gravity.set(0, 0, -9.8 * this.gravity_multiplier);
		this.world.broadphase = new CANNON.NaiveBroadphase();
		this.world.solver.iterations = 14;
		this.world.allowSleep = true;

		// this.scene.add(new THREE.HemisphereLight( 0xffffbb, 0x676771, 1 ));

		this.makeWorldBox()
		
		this.resizeWorld()

		await this.loadTheme({
			colorset: this.theme_colorset,
			texture: this.theme_texture,
			material: this.theme_material
		})
		.catch(e=>{throw new Error("Unable to load theme")})

		if(this.sounds){
			await this.loadSounds()
			.catch(e=>{throw new Error("Unable to load sounds")})
		}

		// this.DiceFactory.setCubeMap(`./themes/${this.theme_surface}/`,THEMES[this.theme_surface].cubeMap)

		this.initialized = true

		this.renderer.render(this.scene, this.camera);

		// The persistent loop is now the sole owner of stepping + rendering, so it
		// must always run (it drives both dice physics and idle VFX render frames).
		this.start();
	}

	makeWorldBox(){
		if(Object.keys(this.box_body).length) {
			this.world.removeBody(this.box_body.desk)
			this.world.removeBody(this.box_body.topWall)
			this.world.removeBody(this.box_body.bottomWall)
			this.world.removeBody(this.box_body.leftWall)
			this.world.removeBody(this.box_body.rightWall)
		}

		const desk_body_material = new CANNON.Material();
		const barrier_body_material = new CANNON.Material();

		this.world.addContactMaterial(new CANNON.ContactMaterial( desk_body_material, this.dice_body_material, {mass:0,friction: 0.6, restitution: 0.5}));
		this.world.addContactMaterial(new CANNON.ContactMaterial( barrier_body_material, this.dice_body_material, {mass:0, friction: 0.6, restitution: 1.0}));
		this.world.addContactMaterial(new CANNON.ContactMaterial( this.dice_body_material, this.dice_body_material, {mass:0,friction: 0.6, restitution: 0.5}));

		this.box_body.desk = new CANNON.Body({allowSleep: false, mass: 0, shape: new CANNON.Plane(), material: desk_body_material})
		this.world.addBody(this.box_body.desk);
		
		this.box_body.topWall = new CANNON.Body({allowSleep: false, mass: 0, shape: new CANNON.Plane(), material: barrier_body_material});
		this.box_body.topWall.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI / 2);
		this.box_body.topWall.position.set(0, this.display.containerHeight * 0.93, 0);
		this.world.addBody(this.box_body.topWall);

		this.box_body.bottomWall = new CANNON.Body({allowSleep: false, mass: 0, shape: new CANNON.Plane(), material: barrier_body_material});
		this.box_body.bottomWall.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
		this.box_body.bottomWall.position.set(0, -this.display.containerHeight * 0.93, 0);
		this.world.addBody(this.box_body.bottomWall);

		this.box_body.leftWall = new CANNON.Body({allowSleep: false, mass: 0, shape: new CANNON.Plane(), material: barrier_body_material});
		this.box_body.leftWall.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), -Math.PI / 2);
		this.box_body.leftWall.position.set(this.display.containerWidth * 0.93, 0, 0);
		this.world.addBody(this.box_body.leftWall);

		this.box_body.rightWall = new CANNON.Body({allowSleep: false, mass: 0, shape: new CANNON.Plane(), material: barrier_body_material});
		this.box_body.rightWall.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI / 2);
		this.box_body.rightWall.position.set(-this.display.containerWidth * 0.93, 0, 0);
		this.world.addBody(this.box_body.rightWall);
	}

	async loadTheme(themeConfig){
		const colorData = await this.resolveColorData(themeConfig && themeConfig.customColorset
			? { customColorset: themeConfig.customColorset }
			: themeConfig)
		this.DiceFactory.applyColorSet(colorData)
		this.colorData = colorData
	}

	// Resolve a theme description to a colorData object WITHOUT mutating global
	// factory/box state — used per group so concurrent rolls keep distinct looks.
	// theme: { colorset?, texture?, material?, customColorset? }; missing fields
	// fall back to the box's configured defaults.
	async resolveColorData(theme = {}){
		if (theme && (theme.customColorset || this.theme_customColorset && theme.useGlobalCustom)) {
			return await this.DiceColors.makeColorSet(theme.customColorset || this.theme_customColorset)
		}
		return await this.DiceColors.getColorSet({
			colorset: theme.colorset || this.theme_colorset,
			texture: theme.texture != null ? theme.texture : this.theme_texture,
			material: theme.material || this.theme_material,
		})
	}

	// The box's current global theme as a theme description (used by the legacy
	// roll()/add() wrappers, which carry no per-group theme of their own).
	currentTheme(){
		if (this.theme_customColorset) return { customColorset: this.theme_customColorset }
		return { colorset: this.theme_colorset, texture: this.theme_texture, material: this.theme_material }
	}

	randomSide(){
		const sides = ['left', 'right', 'top', 'bottom']
		return sides[Math.floor(Math.random() * sides.length)]
	}

	async loadSounds(){
		let surfaces = {
			felt: 7,
			wood_table: 7,
			wood_tray: 7,
			metal: 9
		}

		//TODO: add dice hit noises for other materials
		let dieMaterials = {
			coin: 6,
			metal: 12,
			plastic: 15,
			wood: 12
		}

		const hassound_dieMaterial = this.colorData.texture.material.match(/wood|metal/g)

		this.sound_dieMaterial = hassound_dieMaterial ? this.colorData.texture.material : "plastic"
		
		if(!this.sounds_table.hasOwnProperty(this.surface)){
			this.sounds_table[this.surface] = [];
			let numsounds = surfaces[this.surface]
			for (let s=1; s <= numsounds; ++s) {
				const clip = await this.loadAudio(this.assetPath + 'sounds/surfaces/surface_'+this.surface+s+'.mp3')
				this.sounds_table[this.surface].push(clip);
			}
		}
		// load the coin sounds for all sets
		if(!this.sounds_dice.hasOwnProperty('coin')){
			this.sounds_dice['coin'] = []
			let numsounds = dieMaterials['coin']
			for (let s=1; s <= numsounds; ++s) {
				const clip = await this.loadAudio(this.assetPath + 'sounds/dicehit/dicehit_coin'+s+'.mp3')
				this.sounds_dice['coin'].push(clip);
			}
		}
		if(!this.sounds_dice.hasOwnProperty(this.sound_dieMaterial)){
			this.sounds_dice[this.sound_dieMaterial] = []
			let numsounds = dieMaterials[this.sound_dieMaterial]
			for (let s=1; s <= numsounds; ++s) {
				const clip = await this.loadAudio(this.assetPath + 'sounds/dicehit/dicehit_'+this.sound_dieMaterial+s+'.mp3')
				this.sounds_dice[this.sound_dieMaterial].push(clip);
			}
		}
	}

	loadAudio(src){
		return new Promise((resolve, reject) => {
			let audio = new Audio()
			audio.oncanplaythrough = () => resolve(audio)
			audio.crossOrigin = "anonymous";
			audio.src = src
			audio.onerror = (error) => reject(error)
		}).catch(e => {
			console.error("Unable to load audio")
		})
	}

	async updateConfig(options = {}){
		// if(options.scale && this.scale !== options.scale){
		// 	this.DiceFactory.updateConfig({
		// 		scale: options.scale
		// 	})
		// }
		Object.apply(this,options)
		this.theme_customColorset = options.theme_customColorset ? options.theme_customColorset : null
		if(options.theme_colorset){
			this.theme_colorset = options.theme_colorset
		}
		if(options.theme_texture){
			this.theme_texture = options.theme_texture
		}
		if(options.theme_material){
			this.theme_material = options.theme_material
		}
		if(options.theme_colorset || options.theme_texture || options.theme_material || options.theme_customColorset){
			// A custom colorset wins: it carries its own foreground/background/edge (plus
			// texture+material). Passing only colorset/texture/material here dropped it, so
			// updateConfig() re-themed material+texture but never the custom colours.
			await this.loadTheme(this.theme_customColorset ? {
				customColorset: this.theme_customColorset
			} : {
				colorset: this.theme_colorset,
				texture: this.theme_texture,
				material: this.theme_material
			})
		}

	}

	setDimensions(dimensions) {
		this.display.currentWidth = this.container.clientWidth / 2;
		this.display.currentHeight = this.container.clientHeight / 2;
		if (dimensions) {
			this.display.containerWidth = dimensions.x;
			this.display.containerHeight = dimensions.y;
		} else {
			this.display.containerWidth = this.display.currentWidth;
			this.display.containerHeight = this.display.currentHeight;
		}
		this.display.aspect = Math.min(this.display.currentWidth / this.display.containerWidth, this.display.currentHeight / this.display.containerHeight);
		this.display.scale = Math.sqrt(this.display.containerWidth * this.display.containerWidth + this.display.containerHeight * this.display.containerHeight) / 13;

		this.makeWorldBox()

		this.renderer.setSize(this.display.currentWidth * 2, this.display.currentHeight * 2);

		this.cameraHeight.max = this.display.currentHeight / this.display.aspect / Math.tan(10 * Math.PI / 180);

		this.cameraHeight.medium = this.cameraHeight.max / 1.5;
		this.cameraHeight.far = this.cameraHeight.max;
		this.cameraHeight.close = this.cameraHeight.max / 2;

		if (this.camera) this.scene.remove(this.camera);
		this.camera = new THREE.PerspectiveCamera(20, this.display.currentWidth / this.display.currentHeight, 1, this.cameraHeight.max * 1.3);

		switch (this.animstate) {
			case 'selector':
				this.camera.position.z = this.selector.dice.length > 9 ? this.cameraHeight.far : (this.selector.dice.length < 6 ? this.cameraHeight.close : this.cameraHeight.medium);
				break;
			case 'throw': case 'afterthrow': default: this.camera.position.z = this.cameraHeight.far;

		}

		this.camera.lookAt(new THREE.Vector3(0,0,0));
		
		const maxwidth = Math.max(this.display.containerWidth, this.display.containerHeight);

		if (this.light) this.scene.remove(this.light);
		if (this.light_amb) this.scene.remove(this.light_amb);
		// three r155+ made lights physically-correct and removed useLegacyLights
		// (r165). Scale by PI to restore the pre-r155 brightness these intensities
		// were tuned for, and disable the SpotLight's (now default) inverse-square
		// decay, which would otherwise drop to ~0 over these world distances.
		const lightScale = Math.PI;
		this.light = new THREE.SpotLight(this.color_spotlight, this.light_intensity * lightScale);
		this.light.position.set(-maxwidth / 2, maxwidth / 2, maxwidth * 3);
		this.light.target.position.set(0, 0, 0);
		this.light.distance = maxwidth * 5;
		this.light.decay = 0;
		this.light.angle = Math.PI/4;
		this.light.castShadow = this.shadows;
		this.light.shadow.camera.near = maxwidth / 10;
		this.light.shadow.camera.far = maxwidth * 5;
		this.light.shadow.camera.fov = 50;
		// VSM: bias is near-zero (the blur hides acne); a small radius+blurSamples
		// gives a soft, smooth penumbra. 2048 keeps the base crisp before the blur,
		// so shadows read as a clean soft fade rather than a stair-stepped blob.
		this.light.shadow.bias = -0.0005;
		this.light.shadow.mapSize.width = 2048;
		this.light.shadow.mapSize.height = 2048;
		this.light.shadow.radius = 6;          // VSM Gaussian blur radius (softness)
		this.light.shadow.blurSamples = 16;
		this.scene.add(this.light);
		if (this.renderer) this.renderer.shadowMap.needsUpdate = true; // light rebuilt → refresh

		this.light_amb = new THREE.HemisphereLight( 0xffffbb, 0x676771, this.light_intensity * lightScale );
		this.scene.add(this.light_amb);

		if (this.desk) this.scene.remove(this.desk);
		let shadowplane = new THREE.ShadowMaterial();
		shadowplane.opacity = 0.6; // VSM blur spreads the shadow → a touch more opacity keeps it readable
		this.desk = new THREE.Mesh(new THREE.PlaneGeometry(this.display.containerWidth * 6, this.display.containerHeight * 6, 1, 1), shadowplane);
		this.desk.receiveShadow = this.shadows;
		this.scene.add(this.desk);

		if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
		this.renderer.render(this.scene, this.camera);
	}

	resizeWorld(){
		const resize = () => {
			const canvas = this.renderer.domElement;
			const width = this.container.clientWidth;
			const height = this.container.clientHeight;
			const needResize = canvas.width !== width || canvas.height !== height;
			if (needResize) {
				this.setDimensions(new THREE.Vector2(this.container.clientWidth, this.container.clientHeight))
			}
			return needResize;
		}
		const debounceResize = debounce(resize)
		window.addEventListener("resize", debounceResize)
	}

	vectorRand({x, y}) {
		let angle = Math.random() * Math.PI / 5 - Math.PI / 5 / 2;
		let vec = {
			x: x * Math.cos(angle) - y * Math.sin(angle),
			y: x * Math.sin(angle) + y * Math.cos(angle)
		};
		if (vec.x == 0) vec.x = 0.01;
		if (vec.y == 0) vec.y = 0.01;
		return vec;
	}

	//returns an array of vectordata objects
	getNotationVectors(notation, vector, boost, dist){

		let notationVectors = new DiceNotation(notation);

		for (let i in notationVectors.set) {

			const diceobj = this.DiceFactory.get(notationVectors.set[i].type);
			let numdice = notationVectors.set[i].num;
			let operator = notationVectors.set[i].op;
			let sid = notationVectors.set[i].sid;
			let gid = notationVectors.set[i].gid;
			let glvl = notationVectors.set[i].glvl;
			let func = notationVectors.set[i].func;
			let args = notationVectors.set[i].args;

			for(let k = 0; k < numdice; k++){

				let vec = this.vectorRand(vector);

				vec.x /= dist;
				vec.y /= dist;

				let pos = {
					x: this.display.containerWidth * (vec.x > 0 ? -1 : 1) * 0.9,
					y: this.display.containerHeight * (vec.y > 0 ? -1 : 1) * 0.9,
					z: Math.random() * 200 + 200
				};

				let projector = Math.abs(vec.x / vec.y);
				if (projector > 1.0) pos.y /= projector; else pos.x *= projector;

				let velvec = this.vectorRand(vector);
				velvec.x /= dist;
				velvec.y /= dist;
				let velocity, angle, axis;

				if (diceobj.shape != "d2") {

					velocity = { 
						x: velvec.x * boost, 
						y: velvec.y * boost, 
						z: -10
					};

					angle = {
						x: -(Math.random() * vec.y * 5 + diceobj.inertia * vec.y),
						y: Math.random() * vec.x * 5 + diceobj.inertia * vec.x,
						z: 0
					};

					axis = { 
						x: Math.random(), 
						y: Math.random(), 
						z: Math.random(), 
						a: Math.random()
					};
				} else {
					//coin flip
					velocity = { 
						x: velvec.x * boost / 10, 
						y: velvec.y * boost / 10, 
						z: 3000
					};

					angle = {
						x: 12 * diceobj.inertia,//-(Math.random() * velvec.y * 50 + diceobj.inertia * velvec.y ) ,
						y: 1 * diceobj.inertia,//Math.random() * velvec.x * 50 + diceobj.inertia * velvec.x ,
						z: 0
					};

					axis = { 
						x: 1,//Math.random(), 
						y: 1,//Math.random(), 
						z: Math.random(), 
						a: Math.random()
					};
				}

				notationVectors.vectors.push({ 
					index: this.dieIndex++,
					type: diceobj.type, 
					op: operator,
					sid: sid,  
					gid: gid, 
					glvl: glvl,
					func: func, 
					args: args, 
					pos: pos, 
					velocity: velocity, 
					angle: angle, 
					axis: axis
				});
			}            
		}

		return notationVectors;
	}

	// swaps dice faces to match desired result
	swapDiceFace(dicemesh, result){
		const diceobj = this.DiceFactory.get(dicemesh.notation.type);

		// flag this result as forced
		dicemesh.resultReason = 'forced'

		if (diceobj.shape == 'd4') {
			this.swapDiceFace_D4(dicemesh, result);
			return;
		}

		let values = diceobj.values;
		let value = parseInt(dicemesh.getLastValue().value);
		result = parseInt(result);
		
		if (dicemesh.notation.type == 'd10' && value == 0) value = 10;
		if (dicemesh.notation.type == 'd100' && value == 0) value = 100;
		if (dicemesh.notation.type == 'd100' && (value > 0 && value < 10)) value *= 10;

		if (dicemesh.notation.type == 'd10' && result == 0) result = 10;
		if (dicemesh.notation.type == 'd100' && result == 0) result = 100;
		if (dicemesh.notation.type == 'd100' && (result > 0 && result < 10)) result *= 10;

		let valueindex = diceobj.values.indexOf(value);
		let resultindex = diceobj.values.indexOf(result);

		if (valueindex < 0 || resultindex < 0) return;
		if (valueindex == resultindex) return;

		// find material index for corresponding value -> face and swap them
		// must clone the geom before modifying it
		let geom = dicemesh.geometry.clone();

		// find list of faces that use the matching material index for the given value/result
		let geomindex_value = [];
		let geomindex_result = [];

		// it's magic but not really
		// the mesh's materials start at index 2
		let magic = 2;
		// except on d10 meshes
		if (diceobj.shape == 'd10') magic = 1;

		let material_value, material_result = (resultindex+magic);

		//and D2 meshes have a lot more faces
		if(diceobj.shape != "d2"){
			material_value = (valueindex+magic);
			material_result = (resultindex+magic);
		} else {
			material_value = valueindex+1;
			material_result = resultindex+1;
		}

		//and probably some third rule eventually...

		// let normals = geom.getAttribute('normal').array;
		for (var i = 0, l = geom.groups.length; i < l; ++i) {
			const face = geom.groups[i];
			const matindex = face.materialIndex;

			if (matindex == material_value) {
				geomindex_value.push(i);
				continue;
			}
			if (matindex == material_result) {
				geomindex_result.push(i);
				continue;
			}
		}

		if (geomindex_value.length <= 0 || geomindex_result.length <= 0) return;

		//swap the materials
		for(let i = 0, l = geomindex_result.length; i < l; i++) {
			geom.groups[geomindex_result[i]].materialIndex = material_value;
		}

		for(let i = 0, l = geomindex_value.length; i < l; i++) {
			geom.groups[geomindex_value[i]].materialIndex = material_result;
		}

		dicemesh.geometry = geom;
		dicemesh.result = [];
	}

	swapDiceFace_D4(dicemesh, result) {
		const diceobj = this.DiceFactory.get(dicemesh.notation.type);
		let value = parseInt(dicemesh.getLastValue().value);
		result = parseInt(result);

		if (!(value >= 1 && value <= 4)) return;

		let num = result - value;
		let geom = dicemesh.geometry.clone();

		for (let i = 0, l = geom.groups.length; i < l; ++i) {
			const face = geom.groups[i];
			let matindex = face.materialIndex;
			if (matindex == 0) continue;
        
			matindex += num - 1;

			while (matindex > 4) matindex -= 4;
			while (matindex < 1) matindex += 4;

			face.materialIndex = matindex + 1;
		}
		if (num != 0) {
			if (num < 0) num += 4;
			dicemesh.material = this.DiceFactory.createMaterials(diceobj, 0, 0, false, num);
		}

		dicemesh.geometry = geom;
	}

	//spawns one dicemesh object from a single vectordata object
	spawnDice(vectordata, reset = false, group = null) {
		const {pos, axis, angle, velocity} = vectordata
		let dicemesh

		if(!reset) {
			// The factory bakes materials from its current colorset state (set via
			// applyColorSet just before this group's spawn loop), so each group's
			// dice freeze their own look at creation time.
			dicemesh = this.DiceFactory.create(vectordata.type);
			if(!dicemesh) return;
			dicemesh.notation = vectordata;
			dicemesh.result = [];
			dicemesh.stopped = 0;
			dicemesh.castShadow = this.shadows;
			dicemesh.groupId = group ? group.groupId : undefined;
			dicemesh._group = group;
			this.scene.add(dicemesh);
			this.diceList.push(dicemesh);
		} else {
			dicemesh = reset
			// dicemesh.result = [];
			dicemesh.stopped = 0;
			this.world.removeBody(dicemesh.body);
		}

		dicemesh.body = new CANNON.Body({allowSleep: true, sleepSpeedLimit: 75, sleepTimeLimit:0.9, mass: dicemesh.mass, shape: dicemesh.geometry.cannon_shape, material: this.dice_body_material});
		dicemesh.body.type = CANNON.Body.DYNAMIC;
		dicemesh.body.position.set(pos.x, pos.y, pos.z);
		dicemesh.body.quaternion.setFromAxisAngle(new CANNON.Vec3(axis.x, axis.y, axis.z), axis.a * Math.PI * 2);
		dicemesh.body.angularVelocity.set(angle.x, angle.y, angle.z);
		dicemesh.body.velocity.set(velocity.x, velocity.y, velocity.z);
		dicemesh.body.linearDamping = 0.1;
		dicemesh.body.angularDamping = 0.1;
		dicemesh.body.diceShape = dicemesh.shape;
		dicemesh.body.sleepState = 0;

		dicemesh.body.addEventListener('collide', this.eventCollide.bind(this));

		this.world.addBody(dicemesh.body);
	}

	eventCollide({body, target}) {

		// collision events happen simultaneously for both colliding bodies
		// all this sanity checking helps limits sounds being played

		// don't play sounds if we're simulating
		if (this.animstate == 'simulate') return;
		if (!this.sounds || !body) return;

		// let volume = parseInt(window.DiceFavorites.settings.volume.value) || 0;
		if (this.volume <= 0) return;

		let now = Date.now();
		let currentSoundType = (body.mass > 0) ? 'dice' : 'table';

		// the idea here is that a dice clack should never be skipped in favor of a table sound
		// if ((don't play sounds if we played one this world step, or there hasn't been enough delay) AND 'this sound IS NOT a dice clack') then 'skip it'
		if ((this.lastSoundStep == body.world.stepnumber || this.lastSound > now) && currentSoundType != 'dice') return;

		// also skip if it's too early and both last sound and this sound are the same
		if ((this.lastSoundStep == body.world.stepnumber || this.lastSound > now) && currentSoundType == 'dice' && this.lastSoundType == 'dice') return;

		if (body.mass > 0) { // dice to dice collision

			let speed = body.velocity.length();
			// also don't bother playing at low speeds
			if (speed < 250) return;

			let sound;

			if(body.diceShape === "d2") {
				sound = this.sounds_dice['coin'][Math.floor(Math.random() * this.sounds_dice['coin'].length)];
			}
			else {
				sound = this.sounds_dice[this.sound_dieMaterial][Math.floor(Math.random() * this.sounds_dice[this.sound_dieMaterial].length)];
			}
			if(sound){
				sound.volume = Math.min(speed / 8000, this.volume/100)
				sound.play().catch(error => {});
			}
			// if (isPlaying !== undefined) {
			// 	isPlaying.then(() => {
			// 		// Autoplay started!
			// 	}).catch(error => {
			// 		// Autoplay was prevented.
			// 		// console.warn('Sounds muted by autoplay')
			// 	});
			// }
			this.lastSoundType = 'dice';


		} else { // dice to table collision
			let speed = target.velocity.length();
			// also don't bother playing at low speeds
			if (speed < 250) return;

			let surface = this.surface;

			let soundlist = this.sounds_table[surface];
			let sound = soundlist[Math.floor(Math.random() * soundlist.length)];
			if(sound){
				sound.volume = Math.min(speed / 8000, this.volume/100)
				sound.play().catch(error => {});
			}
			// if (isPlaying !== undefined) {
			// 	isPlaying.then(() => {
			// 		// Autoplay started!
			// 	}).catch(error => {
			// 		// Autoplay was prevented.
			// 		// console.warn('Sounds muted by autoplay')
			// 	});
			// }
			this.lastSoundType = 'table';
		}

		this.lastSoundStep = body.world.stepnumber;
		this.lastSound = now + this.soundDelay;
	}

	checkForRethrow(dicemesh) {
		// all dice in a set/dice group will have the same function and arguments due to sorting beforehand
		// this means the list passed in is the set of dice that need to be affected by this function
		let diceFunc = (dicemesh.notation.func) ? dicemesh.notation.func.toLowerCase() : '';
		// let funcdata = this.DiceFunctions.rethrowFunctions[diceFunc];
		let funcdata

		let reroll = false;
			
		if (diceFunc != '' && funcdata && funcdata.method) {
			diceFunc = dicemesh.notation.func.toLowerCase();
			let diceFuncArgs = dicemesh.notation.args || '';
			reroll = funcdata.method(dicemesh, diceFuncArgs);
		}

		return reroll;
	}

	// Group-scoped settle detection — a clone of the old throwFinished() that
	// iterates ONLY this group's dice, so one group settling never touches another.
	groupFinished(group) {
		const forcedFinish = group.iteration > this.iterationLimit
		const sleepState = CANNON.Body.SLEEPING

		for (let i = 0, len = group.meshes.length; i < len; ++i) {
			const dicemesh = group.meshes[i];
			if (!dicemesh || !dicemesh.body) continue; // removed mid-flight

			if (dicemesh.body.sleepState < sleepState && !forcedFinish) {
				return false;
			}

			if (dicemesh.body.sleepState == sleepState || forcedFinish) {
				if(dicemesh.body.type === CANNON.Body.KINEMATIC){
					continue
				}

				let rethrow = false;

				//check for forced roll
				if (dicemesh.result.length == 0) {
					dicemesh.storeRolledValue(dicemesh.resultReason);
					// Backstop: if this die had a forced target but settled on the wrong
					// face (a cross-group collision the prediction missed, or the cap was
					// hit), relabel it AT REST so the up-face shows the forced value. With
					// the shared-world prediction this should essentially never fire; it
					// guarantees a correct number (at the cost of a one-frame flip) when it
					// does. Forced targets are parallel to group.meshes (same as the throw).
					const forced = group.notationVectors && group.notationVectors.result && group.notationVectors.result[i];
					if (forced != null && dicemesh.getLastValue().value != forced) {
						this.swapDiceFace(dicemesh, forced);
						dicemesh.storeRolledValue('forced');
					}
					rethrow = this.checkForRethrow(dicemesh);
				} else if (dicemesh.result.length > 0 && dicemesh.rerolling) {
					dicemesh.rerolling = false;
					dicemesh.storeRolledValue('reroll');
					rethrow = this.checkForRethrow(dicemesh);
				}

				if (rethrow) {
					dicemesh.rerolls += 1;
					dicemesh.rerolling = true;
					dicemesh.body.wakeUp();
					dicemesh.body.type = CANNON.Body.DYNAMIC;
					dicemesh.body.angularVelocity = new CANNON.Vec3(25, 25, 25);
					dicemesh.body.velocity = new CANNON.Vec3(0, 0, 3000);
					return false;
				}

				dicemesh.rerolling = false;
				dicemesh.body.type = CANNON.Body.KINEMATIC;
			}
		}
		return true;
	}

	// Capture the whole physics world so a blocking prediction can run and be rolled
	// back without disturbing the live animation. With a fixed dt cannon-es clears
	// forces each step, so only these per-body fields (+ world.time, which drives sleep
	// timing) are needed for an exact replay — validated bit-exact for the mid-flight
	// snapshot/restore case in scripts/determinism-spike.mjs.
	snapshotWorld() {
		return {
			time: this.world.time,
			stepnumber: this.world.stepnumber,
			bodies: this.world.bodies.map((b) => ({
				body: b,
				position: b.position.clone(),
				quaternion: b.quaternion.clone(),
				velocity: b.velocity.clone(),
				angularVelocity: b.angularVelocity.clone(),
				sleepState: b.sleepState,
				timeLastSleepy: b.timeLastSleepy,
				type: b.type,
			})),
		};
	}

	restoreWorld(snap) {
		this.world.time = snap.time;
		this.world.stepnumber = snap.stepnumber;
		for (const s of snap.bodies) {
			const b = s.body;
			b.position.copy(s.position);
			b.quaternion.copy(s.quaternion);
			b.velocity.copy(s.velocity);
			b.angularVelocity.copy(s.angularVelocity);
			b.previousPosition.copy(s.position);
			b.interpolatedPosition.copy(s.position);
			b.interpolatedQuaternion.copy(s.quaternion);
			b.force.setZero();
			b.torque.setZero();
			b.vlambda.setZero();
			b.wlambda.setZero();
			b.sleepState = s.sleepState;
			b.timeLastSleepy = s.timeLastSleepy;
			b.type = s.type;
			b.aabbNeedsUpdate = true;
		}
	}

	// Re-predict the SHARED world and relabel every in-flight forced die so its forced
	// value lands up — accounting for collisions between concurrent groups. Called on
	// each new throw (rollback-style): snapshot → fast-forward all in-flight dice to rest
	// (with collisions, mirroring the live loop's freeze-on-sleep) → relabel from the
	// predicted resting orientation → restore. Because the live loop replays the same
	// fixed-dt steps from the restored state, what's shown reproduces this prediction
	// until the next throw re-runs it. Replaces the old per-group, collision-blind sim;
	// groupFinished() carries a guaranteed at-rest backstop for the residual cases.
	predictAndRelabelAll() {
		const SLEEPING = CANNON.Body.SLEEPING, KINEMATIC = CANNON.Body.KINEMATIC;

		// All still-moving dice across every animating group take part in the prediction
		// (forced or not — they all collide); only those with a forced target get relabeled.
		// Dice already settled (slept → KINEMATIC) are immovable obstacles, left untouched.
		const physics = [];                 // every DYNAMIC die in an unsettled group
		const relabel = [];                 // { mesh, target } subset that has a forced value
		for (const group of this.groups.values()) {
			if (group.state !== 'animating' && group.state !== 'spawning') continue;
			const targets = (group.notationVectors && group.notationVectors.result) || null;
			for (let i = 0; i < group.meshes.length; i++) {
				const mesh = group.meshes[i];
				if (!mesh || !mesh.body) continue;
				if (mesh.body.type === KINEMATIC) continue;     // already-settled obstacle
				physics.push(mesh);
				if (targets && targets[i] != null) relabel.push({ mesh, target: targets[i] });
			}
		}
		if (!relabel.length) return;

		const prevAnimstate = this.animstate;
		this.animstate = 'simulate';
		const snap = this.snapshotWorld();

		// Reset each forced die to its pristine (un-swapped) labeling so re-prediction is
		// idempotent: getFaceValue() reads base labels and swapDiceFace() applies one swap.
		// (swapDiceFace always clones, so DiceFactory.geometries[type] stays pristine.)
		for (const { mesh } of relabel) {
			const pristine = this.DiceFactory.geometries[mesh.notation.type];
			if (pristine) mesh.geometry = pristine;
			mesh.result = [];
		}

		// Fast-forward the whole world to rest. Freeze each die KINEMATIC the moment it
		// sleeps, exactly as the live loop (groupFinished) does, so collisions with
		// already-rested dice match what will actually be shown.
		let iter = 0;
		const cap = this.iterationLimit || 1000;
		const allRested = () => {
			for (const m of physics) if (m.body.type !== KINEMATIC && m.body.sleepState !== SLEEPING) return false;
			return true;
		};
		while (iter++ < cap && !allRested()) {
			this.world.step(this.framerate);
			for (const m of physics) if (m.body.sleepState === SLEEPING && m.body.type !== KINEMATIC) m.body.type = KINEMATIC;
		}

		// Relabel each forced die from its predicted resting orientation.
		for (const { mesh, target } of relabel) {
			const natural = mesh.getFaceValue();
			if (natural && natural.value != target) {
				mesh.result = [natural];        // swapDiceFace reads getLastValue()
				this.swapDiceFace(mesh, target);
			}
			mesh.result = [];
		}

		this.restoreWorld(snap);
		this.animstate = prevAnimstate;
	}

	startClickThrow(notation, side) {
		let vector;
		const W = this.display.currentWidth;
		const H = this.display.currentHeight;
		if (side) {
			// Bias the throw direction so the dice enter from the chosen edge. The
			// sign of the velocity vector decides the spawn edge in getNotationVectors
			// (pos is placed opposite the velocity); the perpendicular axis keeps a
			// little jitter so multiple dice from one player still spread naturally.
			const jitter = (mag) => (Math.random() * 2 - 1) * mag * 0.5;
			switch (side) {
				case 'left':   vector = { x:  W, y: jitter(H) }; break;
				case 'right':  vector = { x: -W, y: jitter(H) }; break;
				case 'top':    vector = { x: jitter(W), y: -H }; break;
				case 'bottom': vector = { x: jitter(W), y:  H }; break;
				default:       vector = { x: (Math.random() * 2 - 0.5) * W, y: -(Math.random() * 2 - 0.5) * H };
			}
		} else {
			vector = { x: (Math.random() * 2 - 0.5) * W, y: -(Math.random() * 2 - 0.5) * H };
		}

		let dist = Math.sqrt(vector.x * vector.x + vector.y * vector.y) + 100;
		let boost = (Math.random() + 3) * dist * this.strength;

		return this.getNotationVectors(notation, vector, boost, dist);
	}

	clearDice() {
		this.running = false;
		let dice;
		while (dice = this.diceList.pop()) {
			this.scene.remove(dice);
			if (dice.body) this.world.removeBody(dice.body);
		}
		this.renderer.shadowMap.needsUpdate = true; // dice gone → clear their shadows
		this.renderer.render(this.scene, this.camera);

		setTimeout(() => { this.renderer.shadowMap.needsUpdate = true; this.renderer.render(this.scene, this.camera); }, 100);
	}

	// Remove every die AND every group record. Used by the legacy roll() path
	// (which still has "a new roll wipes the previous one" semantics).
	clearAllGroups() {
		this.clearDice();
		this.groups.clear();
	}

	getDiceResults(id){
		if(id !== undefined){
			return {
				type: this.diceList[id].shape,
				sides: parseInt(this.diceList[id].shape.substring(1)),
				id,
				...this.diceList[id].result.at(-1)
			}
		}
		return this.buildResults(this.notationVectors, this.diceList)
	}

	// Build the roll-result object for a notation + its ordered list of dice meshes.
	// Works for the whole box (this.notationVectors + this.diceList) or for a single
	// group (group.notationVectors + group.meshes), since each list is in set order.
	buildResults(notationVectors, meshes){
		let counter = 0
		const modifier = notationVectors.constant ? parseInt(`${notationVectors.op}${notationVectors.constant}`) : 0
		let rollTotal = modifier
		const result = {
			notation: notationVectors.notation,
			sets: notationVectors.set.map(set => {
				const endCount = counter + set.num - 1
				let setTotal = 0
				const rolls = []
				for (let index = counter; index <= endCount; index++) {
					if(meshes[counter].result.at(-1).reason === "remove") {
						counter++
						continue
					}
					rolls.push({
						type: set.type,
						sides: parseInt(set.type.substring(1)),
						id: counter,
						...meshes[counter].result.at(-1)
					})
					setTotal += meshes[counter].result.at(-1).value
					counter++
				}
				const returnSet = {
					num: set.num,
					type: set.type,
					sides: parseInt(set.type.substring(1)),
					rolls,
					total: setTotal,
				}
				rollTotal += setTotal
				return returnSet
			}),
			modifier,
			total: rollTotal
		}
		return result
	}

	// Per-group result for a single removed die (mirrors getDiceResults(id)).
	singleDieResult(mesh){
		return {
			type: mesh.shape,
			sides: parseInt(mesh.shape.substring(1)),
			...mesh.result.at(-1)
		}
	}

	// --- Concurrent group API (the core of multi-roll support) ---

	// Spawn one independent roll group into the shared scene. Each group keeps its
	// own dice, theme (texture/material/colorset), entry side and settle lifecycle,
	// and resolves when ONLY this group's dice come to rest. Multiple groups can be
	// in flight at once, started at any time, each removed independently.
	//   groupId : app-supplied id (defaults to an auto id)
	//   notation: dice notation, e.g. "2d20@13,8" (forced results supported)
	//   theme   : { colorset?, texture?, material?, customColorset? }
	//   side    : 'left' | 'right' | 'top' | 'bottom' (entry edge)
	async rollGroup({ groupId, notation, theme, colorData, side } = {}) {
		if (!groupId) groupId = `g${Date.now()}_${(this._addCounter++)}`;
		if (this.groups.has(groupId)) this.removeGroup(groupId); // replace any prior group with this id

		// Resolve this group's look BEFORE touching the factory; awaiting here can't
		// interleave the synchronous spawn below (see note) so themes never bleed.
		// Callers may pass a pre-resolved colorData (e.g. an overlay-side cache).
		if (!colorData) colorData = await this.resolveColorData(theme || this.currentTheme());

		const notationVectors = this.startClickThrow(notation, side);
		const group = {
			groupId, notationVectors, colorData, side,
			meshes: [], state: 'spawning', settled: false, iteration: 0, waiters: [],
		};
		this.groups.set(groupId, group);

		const settle = new Promise((resolve) => { group.waiters.push(resolve); });

		if (!notationVectors || notationVectors.error) {
			group.state = 'settled';
			const waiters = group.waiters; group.waiters = [];
			for (const resolve of waiters) { try { resolve(null); } catch (e) {} }
			return settle;
		}

		// Apply this group's colorset to the factory, then spawn — materials bake at
		// creation, so later groups with other themes won't disturb these dice.
		this.DiceFactory.applyColorSet(colorData);
		for (let i = 0, len = notationVectors.vectors.length; i < len; ++i) {
			const before = this.diceList.length;
			this.spawnDice(notationVectors.vectors[i], false, group);
			if (this.diceList.length > before) group.meshes.push(this.diceList[this.diceList.length - 1]);
		}

		// Shared-world prediction: with this group spawned, re-predict the WHOLE box (all
		// in-flight groups together, cross-group collisions included) and relabel every
		// forced die so its value lands up despite bounces. Snapshot/restore leaves the
		// live animation untouched; deterministic replay means what's shown reproduces
		// this prediction until the next throw re-runs it. See predictAndRelabelAll().
		this.predictAndRelabelAll();

		for (const dicemesh of group.meshes) if (dicemesh.body) dicemesh.body.wakeUp();

		group.iteration = 0;
		group.state = 'animating';
		this.rolling = true;
		this._lastStepTime = 0; // restart the step clock so we don't fast-forward
		if (!this._continuousRunning) this.start();

		return settle;
	}

	// Remove just one group's dice + record, leaving any other groups in flight.
	async removeGroup(groupId){
		const group = this.groups.get(groupId);
		if (!group) return [];
		const results = [];
		for (const mesh of group.meshes) {
			if (mesh.body) this.world.removeBody(mesh.body);
			this.scene.remove(mesh);
			mesh.storeRolledValue('remove');
			results.push(this.singleDieResult(mesh));
		}
		group.state = 'removed';
		// drop these meshes from the flat list (object refs elsewhere stay valid;
		// nothing in the group path relies on absolute diceList indices)
		const gone = new Set(group.meshes);
		this.diceList = this.diceList.filter((m) => !gone.has(m));
		this.groups.delete(groupId);
		if (this.renderer) this.renderer.shadowMap.needsUpdate = true; // dice gone → clear their shadows

		this.onRemoveDiceComplete(results);
		document.dispatchEvent(new CustomEvent('removeGroupComplete', { detail: { groupId, results } }));
		return results;
	}

	getGroupResults(groupId){
		const group = this.groups.get(groupId);
		if (!group) return null;
		return this.buildResults(group.notationVectors, group.meshes);
	}

	// --- Back-compat single-roll API, re-implemented on top of groups ---

	async roll(notationSting){
		this.clearAllGroups();
		const results = await this.rollGroup({ groupId: '__default__', notation: notationSting, theme: this.currentTheme(), side: this.randomSide() });
		this.notationVectors = this.groups.get('__default__') ? this.groups.get('__default__').notationVectors : this.notationVectors;
		this.onRollComplete(results);
		document.dispatchEvent(new CustomEvent('rollComplete', { detail: results }));
		return results;
	}

	async add(notationSting){
		const results = await this.rollGroup({ groupId: `__add__${this._addCounter++}`, notation: notationSting, theme: this.currentTheme(), side: this.randomSide() });
		this.onAddDiceComplete(results);
		document.dispatchEvent(new CustomEvent('addDiceComplete', { detail: results }));
		return results;
	}

	async reroll(diceIdArray){
		const affected = new Set();
		diceIdArray.forEach(dieId => {
			const dicemesh = this.diceList[dieId];
			if (!dicemesh || !dicemesh.body) return;
			dicemesh.rerolls += 1;
			dicemesh.rerolling = true;
			dicemesh.body.wakeUp();
			dicemesh.body.type = CANNON.Body.DYNAMIC;
			dicemesh.body.angularVelocity = new CANNON.Vec3(25, 25, 25);
			dicemesh.body.velocity = new CANNON.Vec3(0, 0, 3000);
			if (dicemesh._group) affected.add(dicemesh._group);
		});
		affected.forEach(group => { group.state = 'animating'; group.settled = false; group.iteration = 0; });
		this.rolling = true;
		this._lastStepTime = 0;
		if (!this._continuousRunning) this.start();

		await Promise.all([...affected].map(group => new Promise((resolve) => group.waiters.push(resolve))));
		const results = diceIdArray.map(dieId => this.getDiceResults(dieId));
		this.onRerollComplete(results);
		document.dispatchEvent(new CustomEvent('rerollComplete', { detail: results }));
		return results;
	}

	async remove(diceIdArray){
		const results = [];
		diceIdArray.forEach(dieId => {
			const mesh = this.diceList[dieId];
			if (!mesh) return;
			if (mesh.body) this.world.removeBody(mesh.body);
			this.scene.remove(mesh);
			mesh.storeRolledValue('remove');
			results.push(this.getDiceResults(dieId));
			if (mesh._group) {
				const g = mesh._group;
				g.meshes = g.meshes.filter((m) => m !== mesh);
			}
		});
		this.render();
		this.onRemoveDiceComplete(results);
		document.dispatchEvent(new CustomEvent('removeDiceComplete', { detail: results }));
		return results;
	}
}


export { DiceBox }
