# Engine implementation guide

Use named exports and an index.ts barrel. Keep source files below 400 lines
and tests beside implementations. Preserve provider behavior and public types.
Static descriptors must not import handlers or runtime implementation.
Broker infrastructure moves preserve its existing protocol and security rules.

Every engine's stdout decoder reads its frames through `protocolLines.ts`. A
line that is not JSON is not a frame: it goes to the runtime log, bounded, and
never fails the turn by itself. A stream with no usable terminal frame still
fails, in the decoder's own words.
