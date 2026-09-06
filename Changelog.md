# RimSynapse Changelog

## [dev-tools, unreleased] - Self-sufficient Steam Workshop publish path
The MCP server's `swh_*` family no longer depends on the extension loopback bridge, which with
several MCP servers running was owned by one process and reported "bridge not started" everywhere else.
- **Bridge modes**: the first server to bind `127.0.0.1:8766` is the owner; later servers become a
  proxy to it (`POST /call`), and a port held by something else is reported as `unavailable` with the
  reason. `chrome_status.bridge` shows `mode` + `note` instead of lying.
- **DevTools route** (`server/src/steamCdp.ts`, zero dependencies): `swh_get_auth`, `swh_get_item`,
  `swh_open_item`, `swh_update_description` fall back to it automatically.
- **`swh_update_description`** reads the current text first, refuses descriptions over the 8,000-char
  cap (naming the overage + "drop the oldest changelog block"), warns on unfamiliar link domains, saves,
  and verifies the version line on the public page, returning `{ ok, verified, versionLine, moderation }`.
- **New `swh_get_moderation_state`** (visible / awaiting_analysis / removed / hidden / incompatible, as
  the owner sees it), **`swh_post_changelog`** (find-or-create a pinned "Changelog" Discussions thread;
  dry-run by default, `confirm:true` posts) and **`extract_changelog_block`**.
- **`compose_workshop_bbcode`** asserts the cap and the well-known-domain list.
- **`sync_repo_wiki`** derives `<owner>/<repo>` from the mod's `origin` remote (any org), copies
  `Learning/*.md`, supports `dryRun` (diffstat) and `prune`; `harness/package-release.ps1` resolves
  `-Repo` across every workspace beside the checkout and takes the release slug from `origin`.
- Tests: `server/test/steam-cdp-stub.test.js` (`npm run test:steam`). Docs: `docs/STEAM-PUBLISH.md`.

## [v0.6.0] - The Population Density, Gossip & Legendary Tribute Update
This update introduces dynamic population density propagation on the world map, procedurally generated homesteads, density-based storyteller weight adjustments, a modular visitor gossip rumor system, and robust save-state backlog fixes.

### Features
- **Population Density BFS Model**: Implemented dynamic tile-based population propagation using geodesic BFS. Population propagates outward from NPC settlements and player colonies, halving dynamically with step-wise terrain multipliers (e.g. large hills, mountains, swamps, road linkages, and coastal/water proximity). Displays as "Pawn dwellings: <pop>" on the world inspect pane.
- **Cozy Procedural Homesteads**: Settling or starting on a tile containing non-zero population density triggers the procedural generation of a cozy pre-built wood cabin (4x4 walkable interior, door, wood floor, roof, campfire), and dynamically spawns EITHER an 8x8 growing field sowing potatoes OR an 8x8 fenced pasture pen equipped with a gate and pen marker.
- **Storyteller Density Pacing**: Storyteller weights dynamically scale based on the local population density:
  * High Density (Civilized lands): Suppresses big/small raid threats (multiplied by $\frac{1}{1 + 0.005 \times \text{pop}}$) and increases positive wanderer joins/travelers (multiplied by $0.5 + 0.005 \times \text{pop}$).
  * Low Density (Wild frontier): Acts as a lawless frontier, increasing raid frequencies and making wanderer joins extremely scarce.
- **Modular Gossip & Rumor System**: Friendly and neutral visitors track the most significant events (such as marriages, deaths, bionic surgeries, or MedPod regrowths) witnessed during their stay. Significant events (score $\ge 60$ and $\ge$ average) are logged as core `VisitorRumorSpreading` events in the backlog.
- **Decoupled Newspaper Publishing**: `RimSynapse-WorldNews` sub-hooks `EnqueuePastEvent` to intercept Core's visitor rumors natively, formatting and publishing them as newspaper gossip without requiring circular code dependencies or reflection.
- **Save State Backlog Fix**: All surgery installations, limb restorations (Mech Serums and MedPod regrowth), and legendary art creation events have been converted to use the proper `EnqueuePastEvent` pipeline, resolving a bug where these events were erased upon saving the game.
- **Legendary Inspect Tab & Pawn Vector Rendering**: Expanded the `ITab_Art` pane to display a side-by-side view with generated vector pawn-style art, and added prompt constraints to prevent meta-recursion loops (pawns carving sculptures of themselves carving sculptures).

### API & Endpoint Changes
- **`[ADDED]`** `SynapseCoreWorldComponent.AllEvents` property returning the live runtime `_backlogQueue` queue.
- **`[ADDED]`** `visitorEntryTicks` dictionary in `SynapseCoreWorldComponent` for tracking humanlike visitor presence.
- **`[ADDED]`** `VisitorRumorSpreading` event category for cross-mod narrative scripting.

---

## [v0.5.0] - The Local TTS & Voicebox Integration Update
This update introduces local Text-to-Speech (TTS) integration via Voicebox, enabling high-fidelity speech synthesis without third-party cloud dependencies.

### Features
- **Voicebox TTS Engine Integration**: Added native support for Voicebox, a multi-engine local speech synthesis server supporting Qwen3-TTS, Qwen CustomVoice, LuxTTS, Chatterbox, TADA, and Kokoro.
- **Dynamic Profile Resolution**: Core now dynamically fetches and lists Voicebox profiles (`GET /profiles`) in the Test Bench and routing settings. You can specify a profile either by its name (case-insensitive) or UUID, and the system resolves it on the fly.
- **WAV-to-PCM Audio Processing**: Native parser in VoiceboxProvider extracts raw PCM audio data directly from WAV file responses by parsing the `RIFF WAVE` subchunks, allowing direct playback in RimWorld's audio engine.
- **Audio Routing Expansion**: Both ElevenLabs and Voicebox are now fully exposed in the Query Routing dropdowns when selecting providers for Audio/TTS tasks.
- **Test Bench Audio Tab Upgrades**: The Audio Test Bench now supports selecting Voicebox as a Target Provider, choosing available local profiles from a dynamic dropdown menu, and playing the synthesized audio directly in-game.

### API & Endpoint Changes
- **`[ADDED]`** `ApiProvider.Voicebox` (value `8`) representing the Voicebox provider type.
- **`[ADDED]`** `RoutingId.Voicebox` (value `"Specific_Voicebox"`) for routing storyteller or custom dialog requests directly to Voicebox.
- **`[ADDED]`** Support for custom voice parameters mapping engine name and size from model identifiers (e.g. `qwen:1.7B` translates as engine `"qwen"`, size `"1.7B"`).

---

## [v0.4.0] - The Image Generation & LLM Balancing Update
This update transforms Core into a multi-provider hub, allowing simultaneous connections to OpenAI, Gemini, Claude, and Local LLMs, and introduces a robust background Image Generation framework.

### Features
- **Multi-Provider Hub**: You can now configure Local LM Studio, OpenAI, Google Gemini, Anthropic Claude, and Custom proxies all at the same time in the Settings UI.
- **Query Routing Window**: Companion mods can register specific tasks (e.g., "Flavor Picture Generation" or "NPC Chat"), allowing you to route them to completely different providers. Unrouted tasks gracefully fall back to Local-Only.
- **LLM Capabilities System**: Providers can be tagged with specific capabilities (`Text`, `Image`, `Vision`, `Audio`). The Query Routing window smartly filters providers based on what the companion mod requires.
- **Image Generation Framework**: Core now natively supports generating dynamic images using Pollinations.ai. The LLM writes a descriptive prompt, Core applies your hardcoded art style, downloads the image in the background, and returns a ready-to-use Unity `Texture2D`.
- **Smart Asset Management**: Downloaded images are automatically saved locally to `RimSynapseAssets/[SaveName]`. Core runs a self-cleaning routine on game startup to instantly delete orphaned images for deleted save games.
- **Per-Provider Token Tracking**: Token usage is now tracked independently for every API provider and displayed at the top of the Queue Monitor.

### API & Endpoint Changes
- **`[ADDED]`** `SynapseModHandle.RegisterQueryType(queryId, displayName, requiredCaps)` allows companion mods to expose their tasks to the player's Query Routing window.
- **`[ADDED]`** `SynapseImageClient.GenerateAndSaveImageAsync(...)` provides a one-shot API for generating, saving, and loading dynamic `Texture2D` image assets based on an LLM prompt.
- **`[ADDED]`** `ChatOptions.queryId` allows you to specify which registered routing rule should be applied to a specific `ChatAsync` call.

---

## [v0.3.0] - The World Events and Memory Update
This massive update introduces deep psychological mechanics to `RimSynapse-Psychology`, the `RimSynapse-WorldNews` module to broadcast global events, and formally deprecates the `RimSynapse-StoryTeller` module, integrating its core functionality directly into the Core engine for better stability and cohesiveness.

### Features
- **RimSynapse-WorldNews Introduction**: A new module that generates dynamic, asymmetric in-game newspapers based on your colony's events and the broader world state.
- **World Event Ledger**: Tracks major historical and narrative occurrences as they happen.
- **Storyteller Integration**: The Aura Algorithm and standard storytelling event interception have been successfully migrated from the deprecated `StoryTeller` module into `RimSynapse-Core`.
- **Faction Lore Integration**: Faction generation and history mechanics have been migrated from `StoryTeller` into the `RimSynapse-Factions` module.
- **PTSD & Trauma Breaks**: A new mental state `Synapse_TraumaTrigger` causes pawns with severe negative memories to blindly fire their weapon at surrounding doors, walls, or loud noises before cowering in fear. Hitting a living creature snaps them out of it.
- **Dynamic Personality Traits**: The 24-hour psychological evaluation now tracks profound life events. Pawns can dynamically gain or lose RimWorld `TraitDef`s (such as gaining `Bloodlust` or losing `Kind`) based on LLM analysis of their rolling short-term memory.
- **Player-Driven Therapy**: Players can now right-click pawns to initiate a `Therapy Session`. This opens a new UI window where you can act as a "Guiding Hand" and manually type out the initiating pawn's dialogue, or let the LLM resolve the conversation in the background based on their Intelligence, Social skill, and Ideology.
- **Opportunistic Euphoria**: Pawns who maintain an extremely high mood (>90%) for a sustained 24 in-game hours will now automatically generate a positive core memory.
- **Forced Psychological Reviews**: Added a "Force Psych Review" button to the pawn's Psychology tab, allowing players to demand an immediate LLM clinical evaluation of the pawn's mental state.

### API & Endpoint Changes
- **`[DEPRECATED]`** `RimSynapse-StoryTeller` is officially obsolete. Please unsubscribe from the standalone module.


---

## [v0.2.1] - The Social Dynamics Update
This major update introduces the foundation of RimSynapse-Psychology, drastically changing how pawns interact and remember events.

### Features
- **Trust & Familiarity System**: Replaced vanilla's rigid opinion system with dynamic Trust (-100 to 100) and Familiarity (0 to 100) values.
- **Vanilla Opinion Balancing**: `OpinionOf` is now scaled down by 50% natively, with the custom Trust metric contributing the remaining 50% weight.
- **Ritual Remarks**: Hooked into RimWorld's `MarriageCeremonyUtility` and `RitualOutcomeEffectWorker_Funeral`. Colonists now pull from their LLM relationship memories to deliver Vows and Eulogies during these events.
- **UI Expansion**: Added the **Social Network** tab to the `Dialog_PawnPsychology` window to visualize the Trust/Familiarity metrics and the LLM relationship memories.

### API & Endpoint Changes
- **`[DEPRECATED]`** `SynapseClient.RegisterOpportunisticTask(SynapseModHandle mod, string taskId, Action callback, int cooldownTicks)` is now obsolete.
- **`[ADDED]`** `SynapseClient.RegisterOpportunisticTask(SynapseModHandle mod, string taskId, Action callback, OpportunisticTaskConfig config)` is the new standard API for scheduling background tasks, allowing mods to specify Priority, Weight, and Cooldown via a configuration object.

---

## [v0.2] - Core Engine Overhaul
This update focused on preventing the LLM queue from starving low-priority tasks and ensuring game stability during saves.

### Features
- **Dynamic Scoring**: Implemented a new dynamic scoring algorithm for the LLM priority queue (`Score = (Priority * 100,000) + CappedAgeInTicks - TokenPenalty`). This ensures older, lower-priority tasks (like background lore generation) eventually bubble up and don't starve.
- **Queue Save Linking**: The LLM Request Queue is now serialized. If a player exits and saves the game while LLM queries are queued, those queries will be saved and resume processing upon loading the save.
- **Silent Kill Hook**: Added a hook to silently kill background responses when exiting a game to the main menu, preventing phantom sound notifications from firing.

### API & Endpoint Changes
- **`[CHANGED]`** Internal queue processing now uses dynamic weight scoring instead of strict FIFO within tiers.
- **`[ADDED]`** Added `.AllTraits` serialization fix in `SynapsePsychologyOpportunistic` to properly interface with RimWorld 1.4 trait sets.

---

## [v0.1] - Initial Release
The foundational release of RimSynapse, bringing LLM integration directly into RimWorld.

### Features
- **Asynchronous LLM Dispatch**: Introduced the background thread queue to prevent RimWorld from freezing during HTTP calls to local LM Studio or Ollama instances.
- **Context Embedding Engine**: Built the initial system to snapshot colony wealth, nutrition, and colonist moods for LLM prompts.
- **AI Backstories**: Implemented the first version of dynamic Adulthood backstories for colony-born pawns and AI Faction Leader lore generation.

### API Endpoints
- **`[INITIAL]`** `SynapseCore.Register(modId, displayName, systemPrompt)`
- **`[INITIAL]`** `SynapseClient.ChatAsync(...)` and formatting wrappers.
- **`[INITIAL]`** `SynapseCoreContext.GetContextText(...)`
