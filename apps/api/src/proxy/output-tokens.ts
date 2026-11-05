export function resolveMaxOutputTokens(
	requested: number | null | undefined,
	modelCap: number | null | undefined,
	fallback: number
): number {
	const cap = validTokenLimit(modelCap) ? modelCap : undefined;
	if (validTokenLimit(requested)) return cap === undefined ? requested : Math.min(requested, cap);

	return cap ?? fallback;
}

function validTokenLimit(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
