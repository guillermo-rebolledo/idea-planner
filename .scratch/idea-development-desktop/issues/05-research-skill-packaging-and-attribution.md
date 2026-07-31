# Research skill packaging and attribution

Type: research
Status: resolved

## Question

What technical, availability, licensing, and attribution constraints govern using the installed Grill Me and Wayfinder skills as product workflows, and what must the app do when those skills are missing or differ between Codex and Claude environments?

## Answer

Treat Grill Me and Wayfinder as discoverable external workflow dependencies behind harness-specific adapters: verify the complete dependency closure, invoke the exact installed skill identity, pin each Run to path/version/hash provenance, and fail visibly without silent emulation or installation. The inspected skills match upstream commit `2ab9580` and are MIT-licensed; redistribution or embedding must retain Matt Pocock's copyright and permission notice, while visible “based on” credit is recommended without implying endorsement. See [Skill packaging and attribution research](../research/skill-packaging-and-attribution.md).
