<div align="center">

# ICEBERG

**Your computer, calved in Git. Thawed anywhere.**

A real Alpine Linux machine that runs in your browser and stores its saved states
in your own private GitHub repository. No backend. No database. No account with us.

</div>

---

Nine tenths of an iceberg is below the waterline. What you are looking at — the
running session, the terminal, the file you have open — is the small part. The
mass is in your repository, and that is the part that persists.

You configure a development environment once. You **calve** it under a name.
Later, somewhere else, with only a phone, you open the page, pick the name, and
**thaw** it. The machine comes back as it was.

## What makes it different

- **Nothing is ever saved by accident.** Install four hundred packages, break the
  kernel, change your mind — the floe you thawed from is exactly as it was.
  Saving is a decision you make, not something that happens to you.
- **Adding a compiler costs the compiler, not the machine.** The filesystem is
  chunked at content-defined boundaries, so floes share everything they have in
  common. A vault holding a dozen environments is hundreds of megabytes, not tens
  of gigabytes.
- **The machine sleeps when you are only typing.** The filesystem lives on the
  browser's side, so the editor works with the emulated CPU completely parked.
- **The guest never holds your GitHub token.** Not by policy — by construction.

## Vocabulary

| Term | Meaning |
|---|---|
| **Floe** | a saved machine — immutable, named, complete |
| **BASE** | the factory machine. Always there, never editable, never removable |
| **Session** | the machine you are using right now, in this tab |
| **Drift** | everything the session has changed since it was thawed |
| **Thaw** | turn a floe into a running session |
| **Calve** | save the session as a new floe |
| **Melt** | throw the drift away |
| **Scuttle** | shut the machine down |
| **Keel** | the deduplicated chunk store — the mass below the line |
| **Vault** | your private repository, `iceberg-vault` |
| **Awash / Submerged** | the two sleep depths |

---

## Deploying

Everything needed for hosting sits at the repository root. There is no build step
and no bundler.

### 1. Publish the site

```bash
git clone https://github.com/<you>/iceberg-web
cd iceberg-web
```

Push to a repository and turn on **Settings → Pages → Deploy from a branch**,
selecting the branch and `/ (root)`. `.nojekyll` is already present, which matters
— without it, GitHub Pages would refuse to serve the `js/` directory.

Iceberg needs a **secure context**: HTTPS or `http://localhost`. Web Crypto is
withheld elsewhere, and nothing will work from `file://`.

### 2. Fetch the emulator

v86 is not vendored — it is a large build artifact with its own release cadence.

```bash
./tools/fetch-vendor.sh          # or: V86_REF=v0.5.0 ./tools/fetch-vendor.sh
```

This places `vendor/libv86.mjs` and `vendor/v86.wasm`.

### 3. Build the base image

Every user's BASE points at this, and it is served publicly from the site so it
can be CDN-cached and shared. Build it once and commit it.

```bash
curl -LO https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86/alpine-minirootfs-3.21.0-x86.tar.gz
mkdir rootfs && tar -xzf alpine-minirootfs-*.tar.gz -C rootfs
# add a kernel and initramfs under rootfs/boot

node tools/build-image.mjs rootfs alpine-3.21-x86 --label "Alpine 3.21" --version "3.21"
```

Produces `images/alpine-3.21-x86/` — a manifest plus content-addressed chunks.
Set `IMAGES.default` in `js/config.js` to the image id.

> The builder cross-checks its chunking constants against `js/config.js` and
> fails if they diverge. Do not "fix" one side alone: if the browser and the
> builder disagree about where a chunk boundary falls, every user's vault
> silently doubles in size.

### 4. Sign-in (optional)

The default path — a fine-grained token the user creates themselves — needs no
infrastructure at all. If you also want "Sign in with GitHub", deploy the relay,
which is stateless and stores nothing:

```bash
cd relay && wrangler deploy
wrangler secret put CLIENT_SECRET
```

Then set `OAUTH.RELAY_URL` and `OAUTH.CLIENT_ID` in `js/config.js`. Leave them
blank and the button never appears.

## Local development

```bash
python3 -m http.server 8000      # http://localhost:8000 is a secure context
node tools/test-chunker.mjs      # verify the chunker before touching it
```

## Layout

```
├── index.html            landing page
├── machine.html          the machine
├── docs.html             the manual
├── 404.html
├── .nojekyll             required — Pages skips js/ without it
├── styles/
├── js/
│   ├── config.js         all constants, and the vocabulary
│   ├── chunker.js        content-defined chunking (tested)
│   ├── keel.js           the chunk store
│   ├── snapshot.js       filesystem capture and reconstruction
│   ├── floes.js          calve / thaw / rename / forget
│   ├── vault.js          repository provisioning and commits
│   ├── machine.js        v86 lifecycle and sleep depths
│   ├── session.js        drift tracking and unload guards
│   ├── vfetch.js         the virtual origin — the credential boundary
│   └── ui/
├── images/               public base images (built, committed)
├── vendor/               v86 (fetched, not committed)
├── relay/                optional stateless sign-in shim
└── tools/
```

## Honest limitations

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) §9 for the full list, and `docs.html#limits`
for the user-facing version. In brief:

- **32-bit x86, ~10–30× slower than native.** Editing, scripting and small builds
  are real. A build farm this is not.
- **The guest has no internet** without a network relay you supply. Packages
  otherwise arrive through a browser-side courier.
- **GitHub limits bind**: 5 000 API calls an hour, and repositories should stay
  under a gigabyte. Iceberg models both and refuses what it cannot finish.
- **Browser storage is evictable.** An uncalved session is only as safe as the
  browser feels like being.
- **Nothing here sandboxes your code from you.** v86 is an emulator, not a
  security boundary.

## Prior art

Iceberg shares one idea with [Thermite](https://github.com/microserv-net/thermite-web):
GitHub is the infrastructure, not a place to put an application that needs one.
Everything else is different — Thermite turns source into binaries, Iceberg turns
a repository into a computer.

Built on [v86](https://github.com/copy/v86) (Fabian Hemmer, BSD-2-Clause),
[xterm.js](https://xtermjs.org), and [CodeMirror 6](https://codemirror.net).
