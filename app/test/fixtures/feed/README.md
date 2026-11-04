The local update feed of the updater tests (task 13). `feed-server.ts` serves what an app asks for from memory on a loopback port, and writes the `latest.yml` electron-updater reads.
The tests make their Ed25519 pair with `makeTestKey()`; no key is stored here or anywhere in the repository.
