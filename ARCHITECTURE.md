# Iceberg — architecture

> A real Linux machine that runs in the browser and stores its saved states in the
> user's own private GitHub repository. No backend, no database, no account with us.

This document is the design record. It states what was decided, what it cost, and
what does not work. The manual (`docs.html`) is for people using Iceberg; this is
for people who want to know whether it actually holds up.

---

## 1. The shape of the thing

```
        ┌──────────────────────── the browser tab ────────────────────────┐
        │                                                                 │
        │   xterm.js ──┐                          ┌── CodeMirror 6        │
        │              │                          │                       │
        │              ▼                          ▼                       │
        │            ┌──────────────────────────────┐                     │
        │            │  v86  —  x86 CPU in WASM      │                    │
        │            │  Alpine Linux, 9p filesystem  │                    │
        │            └───────────┬──────────────────┘                     │
        │                        │ reads files by content hash            │
        │                        ▼                                        │
        │            ┌──────────────────────────────┐                     │
        │            │  virtual origin (no network)  │  ◀── the boundary  │
        │            └───────────┬──────────────────┘                     │
        │                        ▼                                        │
        │              keel  →  IndexedDB cache                           │
        │                        │                                        │
        └────────────────────────┼────────────────────────────────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
        public base image                 <user>/iceberg-vault
        (this site, CDN, no token)        (private, their account)
```

Two repositories, as in Thermite:

| | |
|---|---|
| **`iceberg-web`** | this static site. Public. Contains no user data, ever. |
| **`<user>/iceberg-vault`** | one per user. **Private.** Contains their machines. |

There is no third thing. No database, no queue, no object store, no per-user
record anywhere in our control. A user's machines are in a repository they own,
and if this site vanished, any copy of it — including one they host themselves —
would open them.

---

## 2. Emulator: why v86

The realistic browser options for booting a genuine Alpine userland are v86
(x86, hand-written WASM), a QEMU/TCG port, or something in the Emscripten-QEMU
family. v86 was chosen for one reason that outweighs the rest:

**v86's 9p filesystem lives in JavaScript, not inside an opaque disk image.**

That single property is what makes the product possible:

1. **The editor can work while the CPU is parked.** Reads and writes go to
   `emulator.fs9p` directly. Opening a file wakes nothing. If the filesystem were
   a block device, every file read would require a running guest to service it,
   and "the machine sleeps while you type" would be a lie.
2. **Drift is measurable without hashing the world.** The 9p inode table carries
   size and mtime. Comparing it to the baseline taken at thaw gives an exact
   changed-file set in milliseconds, on every poll, with no I/O.
3. **Capture is a filesystem walk, not a disk dump.** We serialise files, not
   sectors — so free space, journal churn and block allocation noise never enter
   the stream. A block-level snapshot of a 1 GB disk costs 1 GB and changes in
   places nobody wrote.
4. **Lazy loading is native.** v86 fetches file contents on demand by content
   hash. Boot reads a few hundred files out of tens of thousands, so a machine
   starts long before it has been fully downloaded.

### What it costs

- **32-bit x86 only.** No amd64 packages, ever.
- **~10–30× slower than native, single core.** Real for editing, scripting and
  small builds. Not a build farm. Stated plainly on the landing page rather than
  discovered by a disappointed user.
- **No sandbox guarantee.** v86 is an emulator, not a security boundary. Guest
  code is confined to the emulator by ordinary JS semantics, and that is all.
  The manual says so in the security chapter without hedging.
- **Coupling.** We depend on `fs9p` internals (`inodes`, `Search`,
  `CreateDirectory`, `Unlink`) and on the JSON filesystem format version. This is
  the single largest maintenance risk in the project, so it is confined to
  exactly two files — `js/fs.js` and `toBaseFS()` in `js/snapshot.js` — both
  marked as the places to change when v86 moves.

---

## 3. Storage: the keel

### 3.1 The problem

A machine is ~40 000 files and a few hundred megabytes. The naive designs both
fail, and it is worth being explicit about how:

| Approach | Why it fails |
|---|---|
| Commit the disk image | Every save costs the whole machine. Git deltas do nothing useful on a compressed binary. Ten states = tens of GB. |
| Commit the files individually | GitHub's Git Data API is one call per blob. 40 000 blobs = 40 000 calls against a 5 000/hour budget. A first save would take eight hours. |
| `git push` a packfile from the browser | The smart HTTP protocol needs `receive-pack`, which the REST API does not expose and CORS does not permit. |

### 3.2 What Iceberg does

**All regular file contents are concatenated, in path-sorted order, into one
virtual byte stream. That stream is cut into chunks at content-defined
boundaries. Each chunk is stored once, at a path equal to its own hash.**

```
/bin/busybox  /etc/apk/repositories  /etc/passwd  /usr/lib/libc.so ...
└──────────────────── one stream, path order ────────────────────┘
   │        │          │        │        │        │
   └ chunk ─┴─ chunk ──┴─ chunk ┴─ chunk ┴─ chunk ┴─ …     ~1 MB average
```

A floe is then: a **manifest** (an ordered list of chunk hashes) plus an
**index** (for each file: path, mode, uid/gid, mtime, size, offset into the
stream, and its own sha256). The index is itself deflated and chunked, because it
is a few MB for a real filesystem and changes on every calve.

Layout inside the vault:

```
iceberg-vault/
├── index.json                  the shelf: names → floes, and metadata
├── floes/<ulid>.json           one manifest per floe
├── keel/<aa>/<sha256>          chunks, deflate-raw, path == content hash
└── .iceberg/vault.json         schema version, image pin, machine config
```

### 3.3 Why content-defined boundaries

Fixed-size blocks break on insertion. Add a file near the front of a path-ordered
stream and every subsequent byte shifts; every fixed block after the insertion
point differs, and the "incremental" save uploads the entire machine.

Content-defined chunking cuts where a rolling hash over the *content* says to, so
boundaries move with the data and re-synchronise within roughly one chunk.

Gear hash, `h = (h << 1) + G[byte]`, with a fixed xorshift-seeded table
(`0x1f2e3d4c` — **never change this seed**), a 20-bit mask (1 MB average), a
256 KB floor and a 4 MB ceiling. Floor and ceiling matter: without the floor,
pathological content produces millions of tiny chunks and blows the API budget;
without the ceiling, a large incompressible file becomes one chunk and destroys
locality.

This is not asserted — `tools/test-chunker.mjs` measures it:

```
a 256 KB insertion keeps 41/43 chunks (95.3%)
3.75 MB new out of 48 MB
for contrast: fixed 1 MB blocks would have uploaded 39.3 MB for the same edit
```

### 3.4 Why the path is the hash

Because Git then does the deduplication for free. Two floes referencing the same
chunk reference the same path with the same bytes, so the tree entry points at
one blob and the object is stored once in the pack. Before uploading, Iceberg
reads the existing `keel/` tree recursively (one call) and skips every chunk
already present — so the *upload* is deduplicated too, not just the storage.

### 3.5 The base image is not in the vault

The clean Alpine rootfs is ~35 000 files and several hundred MB of chunks,
identical for every user. Writing it into each vault would mean hundreds of API
calls and hundreds of MB of duplicated bytes per person, for content nobody
authored.

Instead it is published by *this* repository at `images/<id>/`, with a manifest
and its chunks, and pinned by hash from the vault. It is public, immutable and
CDN-cached, so most of what a thaw needs is a plain cacheable fetch with **no
Authorization header at all**. Only the user's own deltas come out of the private
vault.

The honest trade-off: a vault is not fully self-contained. It references an
immutable public artifact. Mitigations — the reference is pinned by content hash
so it cannot be swapped underneath a user; the image format is identical to a
floe's, so "seal the image into the vault" is a straightforward future addition
for anyone who wants total independence.

### 3.6 Calve ordering

The failure mode to design against is a half-applied save. Order:

1. Upload every new chunk as a blob. *Nothing references them.*
2. Upload the index chunks. *Still nothing references them.*
3. **One commit** introducing the manifest and the updated `index.json` together.

An interrupted calve therefore leaves orphan blobs that nothing points at and a
vault that is byte-for-byte unchanged from the user's perspective. GitHub
collects unreferenced objects on its own schedule; we cannot force this and the
manual does not pretend otherwise.

Ref updates use `force: false` — a compare-and-swap. Two devices calving at once
produce two commits, never a lost one; the loser rebases and retries.

---

## 4. Sessions, drift, and never saving anything by accident

The rule the product is built on: **nothing inside a running machine is ever
written to GitHub on its own.**

- **Floe** — immutable, named, a commit.
- **Session** — a running machine in one tab. Exists nowhere else.
- **Drift** — the difference between them, computed from 9p inode metadata every
  6 seconds and shown continuously in the status ribbon.

Every route out of the machine — closing the tab, going to the shelf, thawing
something else, signing out — checks drift first and offers calve / melt /
cancel. `beforeunload` catches deliberate navigation; `pagehide` and
`visibilitychange` handle mobile, where the browser will not ask permission
before taking the tab away.

Because drift is metadata-only, this costs nothing. Hashing 40 000 files every
six seconds would not have been possible; comparing 40 000 `(size, mtime)` pairs
is trivial.

### Spill

Between the two, Iceberg writes changed *small* files (≤ 512 KB) to IndexedDB
every 60 seconds. This is explicitly **not a backup** and is described as such:
it is a way to recover a file you were editing when the tab died, not a way to
recover the machine. The machine's recovery path is Submerged.

---

## 5. Sleep

Two depths, because one would be dishonest:

| State | What it is | Cost | Wake |
|---|---|---|---|
| Running | executing | full CPU | — |
| **Awash** | run loop parked after 45 s idle, memory retained | 0% CPU | instant, guest never notices |
| **Submerged** | `save_state()` → IndexedDB, emulator destroyed, after 8 min or on `pagehide` | nothing at all | a few seconds |

Awash alone is insufficient: a backgrounded mobile tab gets discarded outright,
taking the retained memory with it. Submerged exists so that the machine survives
that, a reload, or a crash.

Anything needing the guest wakes it. Nothing about file editing does, because the
filesystem is on the browser's side. The ribbon always names the state, and a
sleeping machine is never rendered as if it were working.

**Warm floes** — `save_state()` captured into the floe, so thawing resumes rather
than boots — are supported and opt-in. They cost roughly the machine's RAM per
floe and are tied to the emulator build that produced them. Cold is the default
because cold is portable.

---

## 6. Authentication

The primary path is a **fine-grained personal access token**, and it needs no
infrastructure whatsoever:

| Permission | Level | Why |
|---|---|---|
| Administration | read/write | create the vault, once |
| Contents | read/write | the entire product |
| Metadata | read | GitHub adds it automatically |

Not requested, and shown as such next to the request: Actions, secrets, packages,
pull requests, issues, workflows, org access, anything on other repositories.
After first run, the manual tells the user to narrow the key to `iceberg-vault`
alone — first run cannot be scoped that way only because the repository does not
exist yet.

**Storage.** `sessionStorage` by default, so it dies with the tab. "Remember on
this device" wraps the token with AES-GCM under PBKDF2-SHA256(310 000) of a
passphrase; the plaintext token never reaches persistent storage.

**Transmission.** `js/github.js` asserts the target origin is `api.github.com`
before every request and throws otherwise. There is no code path that sends the
token anywhere else.

### The relay, and why it is optional

"Sign in with GitHub" (device flow) needs `github.com/login/device/code` and
`/login/oauth/access_token`. Both require a client secret and neither sends CORS
headers, so a browser is physically unable to call them and a static site cannot
hold the secret. This is the one thing that genuinely cannot be done from a
static page — the same conclusion Thermite reached.

`relay/worker.js` is the answer: ~50 lines, stateless, stores nothing, logs
nothing, adds the secret and passes the response through. Deployments may simply
not run it, in which case the sign-in button never appears and the token path —
which needs nothing — is the only route. A backend was not introduced because it
was convenient; it exists solely where GitHub leaves no alternative.

---

## 7. The credential boundary

The guest can install and run arbitrary software. It must never be able to reach
the user's GitHub access. This is structural, not a policy:

v86 fetches filesystem content from a **virtual origin**,
`https://keel.iceberg.invalid`. That hostname does not resolve and requests to it
never reach the network — `js/vfetch.js` shims `fetch` and `XMLHttpRequest`,
intercepts them, and answers from the keel on the browser's side of the
boundary.

The consequences:

- The guest has no token, no API client, and no route to one.
- The handler runs in page context, which the guest cannot address.
- Chunk resolution is cache → public image → vault, and only the last of those
  attaches an Authorization header, in code the guest cannot invoke.

What this does *not* protect against, stated in the manual: the vault is private
but **not encrypted**. Anything calved into a floe — an SSH key, a token in a
dotfile — sits in a private GitHub repository in the clear.

---

## 8. Networking, honestly

**The guest has no internet.** A browser cannot open a raw TCP socket, so v86's
network card has nothing to attach to. This is a property of browsers.

Two honest answers:

1. **The courier** (no infrastructure): fetch an `.apk` in the browser from a
   CORS-permitting mirror, write it into the guest filesystem, install from disk,
   resolving dependencies from the index the same way.
2. **A relay you control**: v86 can attach its NIC to a WebSocket proxy, which
   gives real connectivity — `apk add`, `git clone`, everything. Iceberg ships
   none and defaults to none, because a relay sees all of the guest's traffic and
   that is not something to hand a stranger by default.

Once software is installed and calved, it is *in* the floe. Thawing needs no
network beyond the vault.

---

## 9. Limits that actually bind

| | |
|---|---|
| API rate | 5 000/hour. A first calve of a large toolchain can use several hundred. `js/github.js` models the budget, slows as it thins, and refuses to start what it cannot finish rather than dying halfway. |
| Secondary limits | GitHub's undocumented burst limiter. Concurrency is capped and `Retry-After` is honoured. |
| Repository size | Advisory ~1 GB, hard pushback well before 5 GB. Warn at 800 MB, refuse to calve past 2 GB. |
| Blob size | 100 MB hard. Chunks are ≤ 4 MB, so this is unreachable — but files > 48 MB inside the machine are refused at calve time, by name, rather than silently dropped. |
| Tab memory | 512 MB guest + filesystem + chunks. Over ~2 GB is risky anywhere and much less on iOS. |
| IndexedDB | Evictable. Persistence is requested; the user is told if the browser declines. |
| Background tabs | Throttled and discarded, especially on mobile. Submerged exists for this. |

---

## 10. Mobile

Not a responsive afterthought — the phone is the reason the product exists.

- **Key rail** above the keyboard: Esc, Tab, sticky Ctrl, `|`, `~`, `/`, arrows.
- **History chips**: recent commands as tappable buttons, because retyping a long
  command on glass is the real reason people give up.
- **Three panes**, one at a time, switched from a bottom bar in thumb reach.
- **`visualViewport`-aware layout**, so the terminal resizes to what the keyboard
  leaves rather than hiding behind it.
- **Submerge on `pagehide`**, because mobile browsers do not ask.

What no amount of design fixes: an emulated CPU on a phone is slow and will drain
the battery. The landing page says so.

---

## 11. What was considered and rejected

| Option | Why not |
|---|---|
| Git LFS | Needs a server; defeats the entire premise. |
| One commit per file change | 40 000 API calls. |
| `git push` from the browser | `receive-pack` is not in the REST API and CORS forbids it. |
| Storing the base image per user | Hundreds of duplicated MB and hundreds of API calls per user, for identical bytes. |
| Monaco | Heavier payload, weak touch support, a worker per language. CodeMirror 6 was built for this case. |
| Autosave | Would destroy the one distinction the product is built on. |
| A backend that proxies GitHub | Then we hold user data and become the thing this design exists to avoid. |
| Public vault | A machine contains a user's environment. Private is not negotiable — Iceberg refuses to adopt a public repository of the vault name. |

---

## 12. Honest status

Written and reasoned end to end; the chunker is tested and passing. **Not yet run
against a live v86 build or a real GitHub account.** The expected first failures
are the v86 coupling points — the 9p JSON format version and the `fs9p` internals
in `js/fs.js` and `toBaseFS()`. Both are isolated and commented for exactly that
reason.

`tools/build-image.mjs` cross-checks its chunking constants against
`js/config.js` and fails the build if they diverge, because a silent divergence
there would mean every user's vault quietly doubling in size — the kind of bug
that is invisible until it is expensive.
