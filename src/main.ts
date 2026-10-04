import { ItemView, Plugin, WorkspaceLeaf } from 'obsidian';

const VIEW_TYPE = 'infinite-canvas-view';

type Point = { x: number; y: number; pressure: number };

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error("Impossible d'obtenir un contexte 2D");
	return ctx;
}

export default class InfiniteCanvasPlugin extends Plugin {
	async onload(): Promise<void> {
		this.registerView(VIEW_TYPE, (leaf) => new InfiniteCanvasView(leaf));

		this.addRibbonIcon('pencil', 'Infinite canvas', () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open-infinite-canvas',
			name: 'Ouvrir le canvas infini',
			callback: () => {
				void this.activateView();
			},
		});
	}

	onunload(): void {}

	private async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null =
			workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}
}

class InfiniteCanvasView extends ItemView {
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;
	private container!: HTMLElement;

	private cache!: HTMLCanvasElement;
	private cacheCtx!: CanvasRenderingContext2D;
	private cacheMinX = 0;
	private cacheMinY = 0;
	private cacheW = 0;
	private cacheH = 0;

	private strokes: Point[][] = [];
	private current: Point[] | null = null;

	private offsetX = 0;
	private offsetY = 0;

	private isPanning = false;
	private panStartX = 0;
	private panStartY = 0;
	private panStartOffsetX = 0;
	private panStartOffsetY = 0;

	private isDrawing = false;
	private rafId: number | null = null;
	private dpr = 1;

	private rectLeft = 0;
	private rectTop = 0;

	private strokeColor = '#e0e0e0';

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Infinite canvas';
	}

	getIcon(): string {
		return 'pencil';
	}

	async onOpen(): Promise<void> {
		this.container = this.contentEl;
		this.container.empty();
		this.container.addClass('infinite-canvas-container');

		this.canvas = this.container.createEl('canvas');
		this.canvas.addClass('infinite-canvas');
		this.ctx = get2dContext(this.canvas);

		const style = getComputedStyle(document.body);
		this.strokeColor =
			style.getPropertyValue('--text-normal').trim() || '#e0e0e0';

		this.dpr = window.devicePixelRatio || 1;
		this.initCache();

		const ro = new ResizeObserver(() => {
			this.resize();
		});
		ro.observe(this.container);
		this.register(() => {
			ro.disconnect();
		});

		// Resize initial différé : la sidebar n'est pas encore layoutée à onOpen
		this.scheduleResize();

		this.registerDomEvent(this.canvas, 'pointerdown', this.onPointerDown);
		this.registerDomEvent(this.canvas, 'pointermove', this.onPointerMove);
		this.registerDomEvent(this.canvas, 'pointerup', this.onPointerUp);
		this.registerDomEvent(this.canvas, 'pointercancel', this.onPointerUp);
		this.registerDomEvent(this.canvas, 'pointerleave', this.onPointerUp);

		// Empêche l'autoscroll du middle-click et le menu contextuel
		this.registerDomEvent(this.canvas, 'mousedown', (e) => {
			if (e.button === 1) e.preventDefault();
		});
		this.registerDomEvent(this.canvas, 'auxclick', (e) => {
			e.preventDefault();
		});
		this.registerDomEvent(this.canvas, 'contextmenu', (e) => {
			e.preventDefault();
		});

		// Ctrl+Shift+C : clear
		this.registerDomEvent(this.canvas, 'keydown', (e) => {
			if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
				this.clearAll();
			}
		});

		this.canvas.tabIndex = 0;
	}

	async onClose(): Promise<void> {
		if (this.rafId !== null) {
			window.cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	private scheduleResize(): void {
		const raf = window.requestAnimationFrame(() => {
			this.resize();
		});
		const timeout = window.setTimeout(() => {
			this.resize();
		}, 50);
		this.register(() => {
			window.cancelAnimationFrame(raf);
			window.clearTimeout(timeout);
		});
	}

	// ---------------------------------------------------------------------------
	// Cache
	// ---------------------------------------------------------------------------

	private makeCache(w: number, h: number): HTMLCanvasElement {
		const c = createEl('canvas');
		c.width = Math.max(1, Math.ceil(w * this.dpr));
		c.height = Math.max(1, Math.ceil(h * this.dpr));
		return c;
	}

	private initCache(): void {
		const size = 1500;
		this.cacheMinX = -size / 2;
		this.cacheMinY = -size / 2;
		this.cacheW = size;
		this.cacheH = size;
		this.cache = this.makeCache(size, size);
		this.cacheCtx = get2dContext(this.cache);
	}

	private ensureCacheCovers(
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
	): void {
		const pad = 500;
		const needMinX = Math.min(this.cacheMinX, minX - pad);
		const needMinY = Math.min(this.cacheMinY, minY - pad);
		const needMaxX = Math.max(this.cacheMinX + this.cacheW, maxX + pad);
		const needMaxY = Math.max(this.cacheMinY + this.cacheH, maxY + pad);

		const cacheMaxX = this.cacheMinX + this.cacheW;
		const cacheMaxY = this.cacheMinY + this.cacheH;

		if (
			needMinX === this.cacheMinX &&
			needMinY === this.cacheMinY &&
			needMaxX === cacheMaxX &&
			needMaxY === cacheMaxY
		) {
			return;
		}

		const newW = needMaxX - needMinX;
		const newH = needMaxY - needMinY;

		const newCache = this.makeCache(newW, newH);
		const newCtx = get2dContext(newCache);

		newCtx.drawImage(
			this.cache,
			(this.cacheMinX - needMinX) * this.dpr,
			(this.cacheMinY - needMinY) * this.dpr,
		);

		this.cache = newCache;
		this.cacheCtx = newCtx;
		this.cacheMinX = needMinX;
		this.cacheMinY = needMinY;
		this.cacheW = newW;
		this.cacheH = newH;
	}

	private rebuildCacheFromStrokes(): void {
		this.initCache();
		if (this.strokes.length === 0) return;

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const s of this.strokes) {
			for (const p of s) {
				if (p.x < minX) minX = p.x;
				if (p.y < minY) minY = p.y;
				if (p.x > maxX) maxX = p.x;
				if (p.y > maxY) maxY = p.y;
			}
		}
		this.ensureCacheCovers(minX - 10, minY - 10, maxX + 10, maxY + 10);

		for (const s of this.strokes) this.drawStrokeIntoCache(s);
	}

	private drawStrokeIntoCache(points: Point[]): void {
		const ctx = this.cacheCtx;
		ctx.setTransform(
			this.dpr,
			0,
			0,
			this.dpr,
			-this.cacheMinX * this.dpr,
			-this.cacheMinY * this.dpr,
		);
		this.renderStroke(ctx, points);
	}

	private renderStroke(ctx: CanvasRenderingContext2D, points: Point[]): void {
		if (points.length === 0) return;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.strokeStyle = this.strokeColor;
		ctx.fillStyle = this.strokeColor;

		if (points.length === 1) {
			const p = points[0]!;
			ctx.beginPath();
			ctx.arc(p.x, p.y, 1 + p.pressure * 2, 0, Math.PI * 2);
			ctx.fill();
			return;
		}

		for (let i = 1; i < points.length; i++) {
			const a = points[i - 1]!;
			const b = points[i]!;
			ctx.beginPath();
			ctx.lineWidth = 1 + b.pressure * 3.5;
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
			ctx.stroke();
		}
	}

	private clearAll(): void {
		this.strokes = [];
		this.current = null;
		this.offsetX = 0;
		this.offsetY = 0;
		this.initCache();
		this.scheduleRedraw();
	}

	// ---------------------------------------------------------------------------
	// Layout
	// ---------------------------------------------------------------------------

	private resize(): void {
		const rect = this.container.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;

		const newDpr = window.devicePixelRatio || 1;
		const dprChanged = newDpr !== this.dpr;
		this.dpr = newDpr;

		this.rectLeft = rect.left;
		this.rectTop = rect.top;

		const w = Math.max(1, Math.floor(rect.width * this.dpr));
		const h = Math.max(1, Math.floor(rect.height * this.dpr));

		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}

		if (dprChanged && this.strokes.length > 0) {
			this.rebuildCacheFromStrokes();
		}

		this.scheduleRedraw();
	}

	private updateRect(): void {
		const rect = this.canvas.getBoundingClientRect();
		this.rectLeft = rect.left;
		this.rectTop = rect.top;
	}

	private screenToWorld(
		clientX: number,
		clientY: number,
		pressure: number,
	): Point {
		return {
			x: clientX - this.rectLeft - this.offsetX,
			y: clientY - this.rectTop - this.offsetY,
			pressure: pressure > 0 ? pressure : 0.5,
		};
	}

	// ---------------------------------------------------------------------------
	// Input
	// ---------------------------------------------------------------------------

	private onPointerDown = (e: PointerEvent): void => {
		this.updateRect();

		if (e.button === 1) {
			e.preventDefault();
			this.isPanning = true;
			this.panStartX = e.clientX;
			this.panStartY = e.clientY;
			this.panStartOffsetX = this.offsetX;
			this.panStartOffsetY = this.offsetY;
			this.canvas.addClass('panning');
			this.safeSetPointerCapture(e.pointerId);
			return;
		}

		if (e.button === 0) {
			e.preventDefault();
			this.canvas.focus();
			this.isDrawing = true;
			this.current = [
				this.screenToWorld(e.clientX, e.clientY, e.pressure),
			];
			this.safeSetPointerCapture(e.pointerId);
		}
	};

	private onPointerMove = (e: PointerEvent): void => {
		if (this.isPanning) {
			this.offsetX = this.panStartOffsetX + (e.clientX - this.panStartX);
			this.offsetY = this.panStartOffsetY + (e.clientY - this.panStartY);
			this.scheduleRedraw();
			return;
		}

		if (!this.isDrawing || !this.current) return;

		const events: PointerEvent[] =
			typeof e.getCoalescedEvents === 'function'
				? e.getCoalescedEvents()
				: [e];

		const ctx = this.ctx;
		ctx.setTransform(
			this.dpr,
			0,
			0,
			this.dpr,
			this.dpr * this.offsetX,
			this.dpr * this.offsetY,
		);
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.strokeStyle = this.strokeColor;

		for (const ev of events) {
			const pt = this.screenToWorld(ev.clientX, ev.clientY, ev.pressure);
			const last = this.current[this.current.length - 1];
			if (last) {
				ctx.lineWidth = 1 + pt.pressure * 3.5;
				ctx.beginPath();
				ctx.moveTo(last.x, last.y);
				ctx.lineTo(pt.x, pt.y);
				ctx.stroke();
			}
			this.current.push(pt);
		}
	};

	private onPointerUp = (e: PointerEvent): void => {
		if (this.isPanning) {
			this.isPanning = false;
			this.canvas.removeClass('panning');
		}
		if (this.isDrawing) {
			this.isDrawing = false;
			if (this.current && this.current.length > 0) {
				this.commitStroke(this.current);
			}
			this.current = null;
		}
		this.safeReleasePointerCapture(e.pointerId);
	};

	private safeSetPointerCapture(pointerId: number): void {
		try {
			this.canvas.setPointerCapture(pointerId);
		} catch {
			// Ignoré : peut échouer si le pointeur n'est plus actif
		}
	}

	private safeReleasePointerCapture(pointerId: number): void {
		try {
			this.canvas.releasePointerCapture(pointerId);
		} catch {
			// Ignoré
		}
	}

	private commitStroke(points: Point[]): void {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const p of points) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}
		const r = 10;
		this.ensureCacheCovers(minX - r, minY - r, maxX + r, maxY + r);
		this.drawStrokeIntoCache(points);
		this.strokes.push(points);
	}

	// ---------------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------------

	private redraw(): void {
		this.rafId = null;
		const ctx = this.ctx;
		const dpr = this.dpr;

		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		ctx.setTransform(
			dpr,
			0,
			0,
			dpr,
			dpr * this.offsetX,
			dpr * this.offsetY,
		);

		const viewW = this.canvas.width / dpr;
		const viewH = this.canvas.height / dpr;
		const viewX0 = -this.offsetX;
		const viewY0 = -this.offsetY;
		const viewX1 = viewX0 + viewW;
		const viewY1 = viewY0 + viewH;

		const srcX0 = Math.max(this.cacheMinX, viewX0);
		const srcY0 = Math.max(this.cacheMinY, viewY0);
		const srcX1 = Math.min(this.cacheMinX + this.cacheW, viewX1);
		const srcY1 = Math.min(this.cacheMinY + this.cacheH, viewY1);

		if (srcX1 > srcX0 && srcY1 > srcY0) {
			const cpx = (srcX0 - this.cacheMinX) * dpr;
			const cpy = (srcY0 - this.cacheMinY) * dpr;
			const cpw = (srcX1 - srcX0) * dpr;
			const cph = (srcY1 - srcY0) * dpr;

			ctx.drawImage(
				this.cache,
				cpx,
				cpy,
				cpw,
				cph,
				srcX0,
				srcY0,
				srcX1 - srcX0,
				srcY1 - srcY0,
			);
		}

		if (this.current) {
			this.renderStroke(ctx, this.current);
		}
	}

	private scheduleRedraw(): void {
		if (this.rafId !== null) return;
		this.rafId = window.requestAnimationFrame(() => {
			this.redraw();
		});
	}
}
