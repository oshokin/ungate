/** Browser-side measurement stays JavaScript so tsx does not inject Node-only name helpers. */
export function measureTextContrast() {
	/** @typedef {[number, number, number, number]} Color */
	/** @param {string} value @returns {Color} */
	const rgba = (value) => {
		const values = value.match(/[\d.]+/g)?.map(Number) ?? [];

		return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1];
	};
	/** @param {Color} front @param {Color} back @returns {Color} */
	const blend = (front, back) => [
		front[0] * front[3] + back[0] * (1 - front[3]),
		front[1] * front[3] + back[1] * (1 - front[3]),
		front[2] * front[3] + back[2] * (1 - front[3]),
		1
	];
	/** @param {Element} element @returns {Color} */
	const background = (element) => {
		/** @type {Element[]} */
		const ancestors = [];
		/** @type {Element | null} */
		let current = element;
		for (; current; current = current.parentElement) ancestors.unshift(current);

		return ancestors.reduce(
			(color, ancestor) => blend(rgba(getComputedStyle(ancestor).backgroundColor), color),
			/** @type {Color} */ ([255, 255, 255, 1])
		);
	};
	/** @param {Color} color */
	const luminance = (color) =>
		color
			.slice(0, 3)
			.map((v) => v / 255)
			.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
			.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
	/** @type {{text: string, ratio: number, element: string}[]} */
	const failures = [];
	let count = 0;
	/** @param {Element} element @param {string} text @param {string} [pseudo] */
	const check = (element, text, pseudo) => {
		if (
			!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
			element.closest(':disabled, [aria-disabled="true"]')
		)
			return;
		const style = getComputedStyle(element, pseudo);
		const bg = background(element);
		const color = rgba(style.color);
		color[3] *= Number(style.opacity);
		const a = luminance(blend(color, bg)),
			b = luminance(bg);
		const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
		count++;
		if (ratio < 4.5)
			failures.push({
				text: text.trim().slice(0, 65),
				ratio: Number(ratio.toFixed(2)),
				element: `${element.tagName.toLowerCase()}.${element.getAttribute('class') ?? ''}`
			});
	};
	// The native modal's backdrop intentionally dims the inactive page.
	const root = document.querySelector('dialog[open]') ?? document.body;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.textContent?.trim() && node.parentElement) check(node.parentElement, node.textContent);
	}
	const inputs = /** @type {NodeListOf<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>} */ (
		root.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]), textarea, select')
	);
	for (const input of inputs) {
		check(input, 'Form control text');
		if ('placeholder' in input && input.placeholder && !input.value) check(input, 'Form placeholder', '::placeholder');
	}

	return { count, failures };
}
