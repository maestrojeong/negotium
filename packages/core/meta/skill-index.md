---
date: 2025-05-31
type: index
---

# Skill Index

Total: 110 skills.

## core/apple (5개)

- [[apple-notes]] — Manage Apple Notes via memo CLI: create, search, edit.
- [[apple-reminders]] — Apple Reminders via remindctl: add, list, complete.
- [[findmy]] — Track Apple devices/AirTags via FindMy.app on macOS.
- [[imessage]] — Send and receive iMessages/SMS via the imsg CLI on macOS.
- [[macos-computer-use]] — 

## core/autonomous-ai-agents (5개)

- [[claude-code]] — Delegate coding to Claude Code CLI (features, PRs).
- [[codex]] — Delegate coding to OpenAI Codex CLI (features, PRs).
- [[hermes-agent]] — Configure, extend, or contribute to Hermes Agent.
- [[kanban-codex-lane]] — Use when a Hermes Kanban worker wants to run Codex CLI as an isolated implementation lane while Hermes keeps ownership of task lifecycle, reconciliation, testing, and handoff.
- [[opencode]] — Delegate coding to OpenCode CLI (features, PR review).

## core/creative (19개)

- [[architecture-diagram]] — Dark-themed SVG architecture/cloud/infra diagrams as HTML.
- [[ascii-art]] — ASCII art: pyfiglet, cowsay, boxes, image-to-ascii.
- [[ascii-video]] — ASCII video: convert video/audio to colored ASCII MP4/GIF.
- [[baoyu-article-illustrator]] — Article illustrations: type × style × palette consistency.
- [[baoyu-comic]] — Knowledge comics (知识漫画): educational, biography, tutorial.
- [[baoyu-infographic]] — Infographics: 21 layouts x 21 styles (信息图, 可视化).
- [[claude-design]] — Design one-off HTML artifacts (landing, deck, prototype).
- [[comfyui]] — Generate images, video, and audio with ComfyUI — install, launch, manage nodes/models, run workflows with parameter injection. Uses the official comfy-cli for lifecycle and direct REST/WebSocket API for execution.
- [[design-md]] — Author/validate/export Google's DESIGN.md token spec files.
- [[excalidraw]] — Hand-drawn Excalidraw JSON diagrams (arch, flow, seq).
- [[humanizer]] — Humanize text: strip AI-isms and add real voice.
- [[ideation]] — Generate project ideas via creative constraints.
- [[manim-video]] — Manim CE animations: 3Blue1Brown math/algo videos.
- [[p5js]] — p5.js sketches: gen art, shaders, interactive, 3D.
- [[pixel-art]] — Pixel art w/ era palettes (NES, Game Boy, PICO-8).
- [[popular-web-designs]] — 54 real design systems (Stripe, Linear, Vercel) as HTML/CSS.
- [[pretext]] — Use when building creative browser demos with @chenglou/pretext — DOM-free text layout for ASCII art, typographic flow around obstacles, text-as-geometry games, kinetic typography, and text-powered generative art. Produces single-file HTML demos by default.
- [[sketch]] — Throwaway HTML mockups: 2-3 design variants to compare.
- [[songwriting-and-ai-music]] — Songwriting craft and Suno AI music prompts.

## core/data-science (1개)

- [[jupyter-live-kernel]] — Iterative Python via live Jupyter kernel (hamelnb).

## core/devops (3개)

- [[kanban-orchestrator]] — Decomposition playbook + anti-temptation rules for an orchestrator profile routing work through Kanban. The 
- [[kanban-worker]] — Pitfalls, examples, and edge cases for Hermes Kanban workers. The lifecycle itself is auto-injected into every worker's system prompt as KANBAN_GUIDANCE (from agent/prompt_builder.py); this skill is what you load when you want deeper detail on specific scenarios.
- [[webhook-subscriptions]] — Webhook subscriptions: event-driven agent runs.

## core/github (6개)

- [[codebase-inspection]] — Inspect codebases w/ pygount: LOC, languages, ratios.
- [[github-auth]] — GitHub auth setup: HTTPS tokens, SSH keys, gh CLI login.
- [[github-code-review]] — Review PRs: diffs, inline comments via gh or REST.
- [[github-issues]] — Create, triage, label, assign GitHub issues via gh or REST.
- [[github-pr-workflow]] — GitHub PR lifecycle: branch, commit, open, CI, merge.
- [[github-repo-management]] — Clone/create/fork repos; manage remotes, releases.

## core/mcp (1개)

- [[native-mcp]] — MCP client: connect servers, register tools (stdio/HTTP).

## core/media (5개)

- [[gif-search]] — Search/download GIFs from Tenor via curl + jq.
- [[heartmula]] — HeartMuLa: Suno-like song generation from lyrics + tags.
- [[songsee]] — Audio spectrograms/features (mel, chroma, MFCC) via CLI.
- [[spotify]] — Spotify: play, search, queue, manage playlists and devices.
- [[youtube-content]] — YouTube transcripts to summaries, threads, blogs.

## core/note-taking (1개)

- [[obsidian]] — Read, search, create, and edit notes in the Obsidian vault.

## core/productivity (8개)

- [[airtable]] — Airtable REST API via curl. Records CRUD, filters, upserts.
- [[google-workspace]] — Gmail, Calendar, Drive, Docs, Sheets via gws CLI or Python.
- [[linear]] — Linear: manage issues, projects, teams via GraphQL + curl.
- [[maps]] — Geocode, POIs, routes, timezones via OpenStreetMap/OSRM.
- [[notion]] — Notion API + ntn CLI: pages, databases, markdown, Workers.
- [[ocr-and-documents]] — Extract text from PDFs/scans (pymupdf, marker-pdf).
- [[powerpoint]] — Create, read, edit .pptx decks, slides, notes, templates.
- [[teams-meeting-pipeline]] — Operate the Teams meeting summary pipeline via Hermes CLI — summarize meetings, inspect pipeline status, replay jobs, manage Microsoft Graph subscriptions.

## core/research (4개)

- [[arxiv]] — Search arXiv papers by keyword, author, category, or ID.
- [[blogwatcher]] — Monitor blogs and RSS/Atom feeds via blogwatcher-cli tool.
- [[llm-wiki]] — Karpathy's LLM Wiki: build/query interlinked markdown KB.
- [[research-paper-writing]] — Write ML papers for NeurIPS/ICML/ICLR: design→submit.

## core/social-media (1개)

- [[xurl]] — X/Twitter via xurl CLI: post, search, DM, media, v2 API.

## core/software-development (12개)

- [[debugging-hermes-tui-commands]] — Debug Hermes TUI slash commands: Python, gateway, Ink UI.
- [[hermes-agent-skill-authoring]] — Author in-repo SKILL.md: frontmatter, validator, structure.
- [[hermes-s6-container-supervision]] — Modify, debug, or extend the s6-overlay supervision tree inside the Hermes Agent Docker image — adding new services, debugging profile gateways, understanding the Architecture B main-program pattern.
- [[node-inspect-debugger]] — Debug Node.js via --inspect + Chrome DevTools Protocol CLI.
- [[plan]] — Plan mode: write markdown plan to .hermes/plans/, no exec.
- [[python-debugpy]] — Debug Python: pdb REPL + debugpy remote (DAP).
- [[requesting-code-review]] — Pre-commit review: security scan, quality gates, auto-fix.
- [[spike]] — Throwaway experiments to validate an idea before build.
- [[subagent-driven-development]] — Execute plans via delegate_task subagents (2-stage review).
- [[systematic-debugging]] — 4-phase root cause debugging: understand bugs before fixing.
- [[test-driven-development]] — TDD: enforce RED-GREEN-REFACTOR, tests before code.
- [[writing-plans]] — Write implementation plans: bite-sized tasks, paths, code.

## local/local (8개)

- [[browser-crash-recovery]] — 
- [[document-conversion]] — 
- [[latex-document]] — 
- [[ocr]] — 
- [[skill-creation-guide]] — 스킬 만들기, skill 추가, 워크플로우 정리, skill_save 사용법, 스킬 포맷, 스킬 작성 원칙, skill-creation-guide
- [[video-understanding]] — 
- [[whisper-transcribe]] — 
- [[wiki]] — 

## optional/communication (1개)

- [[one-three-one-rule]] — Structured decision-making framework for technical proposals and trade-off analysis. When the user faces a choice between multiple approaches (architecture decisions, tool selection, refactoring strategies, migration paths), this skill produces a 1-3-1 format: one clear problem statement, three distinct options with pros/cons, and one concrete recommendation with definition of done and implementation plan. Use when the user asks for a 

## optional/creative (4개)

- [[concept-diagrams]] — Generate flat, minimal light/dark-aware SVG diagrams as standalone HTML files, using a unified educational visual language with 9 semantic color ramps, sentence-case typography, and automatic dark mode. Best suited for educational and non-software visuals — physics setups, chemistry mechanisms, math curves, physical objects (aircraft, turbines, smartphones, mechanical watches), anatomy, floor plans, cross-sections, narrative journeys (lifecycle of X, process of Y), hub-spoke system integrations (smart city, IoT), and exploded layer views. If a more specialized skill exists for the subject (dedicated software/cloud architecture, hand-drawn sketches, animated explainers, etc.), prefer that — otherwise this skill can also serve as a general-purpose SVG diagram fallback with a clean educational look. Ships with 15 example diagrams.
- [[hyperframes]] — Create HTML-based video compositions, animated title cards, social overlays, captioned talking-head videos, audio-reactive visuals, and shader transitions using HyperFrames. HTML is the source of truth for video. Use when the user wants a rendered MP4/WebM from an HTML composition, wants to animate text/logos/charts over media, needs captions synced to audio, wants TTS narration, or wants to convert a website into a video.
- [[kanban-video-orchestrator]] — Plan, set up, and monitor a multi-agent video production pipeline backed by Hermes Kanban. Use when the user wants to make ANY video — narrative film, product/marketing, music video, explainer, ASCII/terminal art, abstract/generative loop, comic, 3D, real-time/installation — and the work warrants decomposition into specialized profiles (writer, designer, animator, renderer, voice, editor, etc.) coordinated through a kanban board. Performs adaptive discovery to scope the brief, designs an appropriate team for the requested style, generates the setup script that creates Hermes profiles + initial kanban task, then helps monitor execution and intervene when tasks stall or fail. Routes scenes to whichever Hermes rendering / audio / design skill fits each beat (`ascii-video`, `manim-video`, `p5js`, `comfyui`, `touchdesigner-mcp`, `blender-mcp`, `pixel-art`, `baoyu-comic`, `claude-design`, `excalidraw`, `songsee`, `heartmula`, …) plus external APIs for TTS, image-gen, and image-to-video as needed.
- [[meme-generation]] — Generate real meme images by picking a template and overlaying text with Pillow. Produces actual .png meme files.

## optional/devops (3개)

- [[docker-management]] — Manage Docker containers, images, volumes, networks, and Compose stacks — lifecycle ops, debugging, cleanup, and Dockerfile optimization.
- [[pinggy-tunnel]] — Zero-install localhost tunnels over SSH via Pinggy.
- [[watchers]] — Poll RSS, JSON APIs, and GitHub with watermark dedup.

## optional/email (1개)

- [[agentmail]] — Give the agent its own dedicated email inbox via AgentMail. Send, receive, and manage email autonomously using agent-owned email addresses (e.g. hermes-agent@agentmail.to).

## optional/finance (3개)

- [[excel-author]] — Build auditable Excel workbooks headless with openpyxl — blue/black/green cell conventions, formulas over hardcodes, named ranges, balance checks, sensitivity tables. Use for financial models, audit outputs, reconciliations.
- [[pptx-author]] — Build PowerPoint decks headless with python-pptx. Pairs with excel-author for model-backed decks where every number traces to a workbook cell. Use for pitch decks, IC memos, earnings notes.
- [[stocks]] — Stock quotes, history, search, compare, crypto via Yahoo.

## optional/health (1개)

- [[fitness-nutrition]] — Gym workout planner and nutrition tracker. Search 690+ exercises by muscle, equipment, or category via wger. Look up macros and calories for 380,000+ foods via USDA FoodData Central. Compute BMI, TDEE, one-rep max, macro splits, and body fat — pure Python, no pip installs. Built for anyone chasing gains, cutting weight, or just trying to eat better.

## optional/mcp (2개)

- [[fastmcp]] — Build, test, inspect, install, and deploy MCP servers with FastMCP in Python. Use when creating a new MCP server, wrapping an API or database as MCP tools, exposing resources or prompts, or preparing a FastMCP server for Claude Code, Cursor, or HTTP deployment.
- [[mcporter]] — Use the mcporter CLI to list, configure, auth, and call MCP servers/tools directly (HTTP or stdio), including ad-hoc servers, config edits, and CLI/type generation.

## optional/productivity (2개)

- [[memento-flashcards]] — Spaced-repetition flashcard system. Create cards from facts or text, chat with flashcards using free-text answers graded by the agent, generate quizzes from YouTube transcripts, review due cards with adaptive scheduling, and export/import decks as CSV.
- [[shopify]] — Shopify Admin & Storefront GraphQL APIs via curl. Products, orders, customers, inventory, metafields.

## optional/research (7개)

- [[bioinformatics]] — Gateway to 400+ bioinformatics skills from bioSkills and ClawBio. Covers genomics, transcriptomics, single-cell, variant calling, pharmacogenomics, metagenomics, structural biology, and more. Fetches domain-specific reference material on demand.
- [[darwinian-evolver]] — Evolve prompts/regex/SQL/code with Imbue's evolution loop.
- [[duckduckgo-search]] — Free web search via DuckDuckGo — text, news, images, videos. No API key needed. Prefer the `ddgs` CLI when installed; use the Python DDGS library only after verifying that `ddgs` is available in the current runtime.
- [[gitnexus-explorer]] — Index a codebase with GitNexus and serve an interactive knowledge graph via web UI + Cloudflare tunnel.
- [[qmd]] — Search personal knowledge bases, notes, docs, and meeting transcripts locally using qmd — a hybrid retrieval engine with BM25, vector search, and LLM reranking. Supports CLI and MCP integration.
- [[scrapling]] — Web scraping with Scrapling - HTTP fetching, stealth browser automation, Cloudflare bypass, and spider crawling via CLI and Python.
- [[searxng-search]] — Free meta-search via SearXNG — aggregates results from 70+ search engines. Self-hosted or use a public instance. No API key needed. Falls back automatically when the web search toolset is unavailable.

## optional/security (4개)

- [[1password]] — Set up and use 1Password CLI (op). Use when installing the CLI, enabling desktop app integration, signing in, and reading/injecting secrets for commands.
- [[oss-forensics]] — 
- [[sherlock]] — OSINT username search across 400+ social networks. Hunt down social media accounts by username.
- [[web-pentest]] — 

## optional/software-development (2개)

- [[code-wiki]] — Generate wiki docs + Mermaid diagrams for any codebase.
- [[rest-graphql-debug]] — Debug REST/GraphQL APIs: status codes, auth, schemas, repro.

## optional/web-development (1개)

- [[page-agent]] — Embed alibaba/page-agent into your own web application — a pure-JavaScript in-page GUI agent that ships as a single <script> tag or npm package and lets end-users of your site drive the UI with natural language (
