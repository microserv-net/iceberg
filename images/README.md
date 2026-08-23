# Base images

Built artifacts, served publicly and CDN-cached. Every user's BASE points at one
of these by content hash; they are never copied into a user's private vault.

Build one with:

    node tools/build-image.mjs <rootfs-dir> <image-id> --label "Alpine 3.21"

which writes `<image-id>/image.json` and `<image-id>/keel/<aa>/<sha256>`.

Then set `IMAGES.default` in `js/config.js` to the image id and commit the result.

Images are immutable. To change one, build a new id — never edit in place, because
existing floes pin the old one by hash.
