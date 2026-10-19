# Codex office source projection

This private source service projects authored office, duty, rule and method context. It does not admit an office, session, allocation or permission.

Duty references retain plain IDs and historical slash spellings. `#id` names the configured agency's duty. A qualified `<estate-relative section>#id` reads exactly that section's `lib/agency/duties/<id>.json`, following Organizing's cross-house source address law. It never substitutes the configured agency's same-named duty for an unavailable owner.

The projection binding may declare `corpusRoot`, resolved relative to the binding file. Otherwise qualified references use `lib` under the already declared `projectRoot` (or the CLI's existing `hostResources.node` project binding). The configured agency and exact duty owner must lie inside that corpus; foreign owner symlink aliases and duty files escaping the selected agency refuse. Cross-house sources retain their owner root, relative path and SHA256 in source custody, with exact owner links in the index.

Skill methods and their linked closure keep the existing configured-agency custody and project discovery policy. Missing methods or refused duty sources leave the last complete context intact. Run the original `npm run verify` before integration; source receiving is separate from projection into a live client and native authority.
