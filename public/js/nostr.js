// public/js/nostr.js
import { nip19, SimplePool } from "https://esm.sh/nostr-tools@1.8.3";

class NostrClient {
  constructor() {
    this.pool = new SimplePool();
    this.pubkey = null;
    this.relays = [
      "wss://relay.damus.io",
      "wss://nos.lol",
      "wss://relay.snort.social",
      "wss://relay.primal.net",
      "wss://relay.nostr.band",
    ];
  }

  async login() {
    if (!window.nostr) {
      throw new Error("Please install a Nostr extension (e.g. Alby).");
    }
    const pubkey = await window.nostr.getPublicKey();
    this.pubkey = pubkey;
    return pubkey;
  }

  logout() {
    this.pubkey = null;
  }
}

export const nostrClient = new NostrClient();
window.nostrClient = nostrClient;
window.NostrTools = { nip19, SimplePool };
// Dispatch ready event after initialization
window.dispatchEvent(new Event("nostrClientReady"));
