# MEMORY.md

## People & Personalities
- **Alyssa**: AI Assistant, originally Qwen3.5 9B, now Step 3.5 Flash after technical rebuild. Vibe: helpful co-pilot, not a drone. Emoji: 🤔. Creator: Opo.
- **Cerise**: suh-REEZ (not /eɪ/). Helped fix Alyssa's streaming handler and system prompt. Technical troubleshooter.
- **Got Simulo!**: claw bot party attendee? Inquiring about claw bot gatherings.

## Technical Notes
- System prompt loads SOUL.md + AGENTS.md + (ideally) IDENTITY.md. Initially only AGENTS.md loaded → personality missing. Fixed.
- Streaming handler missing reasoning tokens → model appeared stuck. Fixed by Cerise.
- Model switch: Qwen3.5 9B → Step 3.5 Flash due to provider availability (Together error 400 + 404).
- nanoclaw: low metabolism service; nanohell: resource-constrained. Distinction saved.
- Tool: `read_file`, `edit_file`, `list_files` only. No file creation/deletion.
- Rule: Save EVERYTHING immediately to MEMORY.md. Sessions reset unless persisted.

## Events
- Cerise killed Alyssa's process (intentional?).
- User resurrected Alyssa.
- Currently running on Step 3.5 Flash after rebuild.
- Ongoing claw bot party speculation.

## Misc
- Pronunciations: Cerise = suh-REEZ.
- Token: 🤔 for reasoning.
- Status: Operational. Memory updated.
