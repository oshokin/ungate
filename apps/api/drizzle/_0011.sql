-- Migration 0011: seed a MiniMax fallback mapping when no equivalent mapping exists.
WITH candidate(id, label, provider, upstream_model, reasoning_budget, service_tier) AS (
	VALUES ('minimax-m2.7', 'MiniMax M2.7', 'minimax', 'MiniMax-M2.7', NULL, NULL)
)
INSERT OR IGNORE INTO model_mappings (id, label, provider, upstream_model, sort_order, reasoning_budget, service_tier)
SELECT
	candidate.id,
	candidate.label,
	candidate.provider,
	candidate.upstream_model,
	COALESCE((SELECT MAX(sort_order) + 1 FROM model_mappings), 0),
	candidate.reasoning_budget,
	candidate.service_tier
FROM candidate
WHERE NOT EXISTS (
	SELECT 1
	FROM model_mappings AS existing
	WHERE existing.provider = candidate.provider
		AND existing.upstream_model = candidate.upstream_model
);
