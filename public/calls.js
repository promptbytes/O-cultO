// O-cultO voice calls.
//
// Audio goes straight between devices over WebRTC, which always encrypts it
// (DTLS-SRTP). The set-up messages (offers, answers, network candidates) are
// sent through the chat's end-to-end encrypted channel, so the relay server
// cannot read or swap them. That means the call is as safe as the chat: if
// your safety code matches, nobody can listen in.
//
// Groups use a "mesh": everyone in the call connects to everyone else.
// That works well for a handful of people, which is what a group here holds.

export class Calls {
  /**
   * @param {object} o
   * @param {() => string} o.myId          our id in the room
   * @param {(id: string, body: object) => void} o.sendTo   encrypted, to one person
   * @param {(body: object) => void} o.broadcast            encrypted, to everyone
   * @param {() => void} o.onChange        UI refresh
   * @param {RTCIceServer[]} o.iceServers
   * @param {HTMLElement} o.audioHost      where remote <audio> elements live
   */
  constructor(o) {
    Object.assign(this, o);
    this.inCall = false;
    this.muted = false;
    this.stream = null;
    this.pcs = new Map(); // peer id -> { pc, audio, pending: [] }
    this.remoteInCall = new Set(); // peer ids we know are in the call
  }

  async start() {
    if (this.inCall) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.inCall = true;
    this.muted = false;
    this.broadcast({ t: 'call-join' });
    this.onChange();
  }

  hangup({ silent = false } = {}) {
    if (!this.inCall) return;
    if (!silent) this.broadcast({ t: 'call-leave' });
    for (const id of [...this.pcs.keys()]) this.closePeer(id);
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
    this.inCall = false;
    this.muted = false;
    this.onChange();
  }

  toggleMute() {
    if (!this.stream) return;
    this.muted = !this.muted;
    for (const track of this.stream.getAudioTracks()) track.enabled = !this.muted;
    this.onChange();
  }

  /** Someone left the chat. */
  peerLeft(id) {
    this.remoteInCall.delete(id);
    this.closePeer(id);
    this.onChange();
  }

  /** Learned from a 'hi' that this person is already in the call. */
  noteInCall(id, inCall) {
    if (inCall) this.remoteInCall.add(id); else this.remoteInCall.delete(id);
    this.onChange();
  }

  /** Handle a decrypted call-* message from peer `from`. */
  async handle(from, body) {
    switch (body.t) {
      case 'call-join':
        this.remoteInCall.add(from);
        this.onChange();
        if (!this.inCall || this.pcs.has(from)) return;
        // Exactly one side makes the offer, so offers never collide.
        if (this.myId() < from) await this.offer(from);
        else this.sendTo(from, { t: 'call-join' });
        return;

      case 'call-leave':
        this.remoteInCall.delete(from);
        this.closePeer(from);
        this.onChange();
        return;

      case 'call-offer': {
        if (!this.inCall || typeof body.sdp !== 'string') return;
        this.remoteInCall.add(from);
        this.closePeer(from);
        const entry = this.makePeer(from);
        await entry.pc.setRemoteDescription({ type: 'offer', sdp: body.sdp });
        await this.flush(entry);
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        this.sendTo(from, { t: 'call-answer', sdp: entry.pc.localDescription.sdp });
        return;
      }

      case 'call-answer': {
        const entry = this.pcs.get(from);
        if (!entry || typeof body.sdp !== 'string' || entry.pc.signalingState !== 'have-local-offer') return;
        await entry.pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
        await this.flush(entry);
        return;
      }

      case 'call-ice': {
        const entry = this.pcs.get(from);
        if (!entry || !body.c) return;
        if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(body.c).catch(() => {});
        else entry.pending.push(body.c);
        return;
      }
    }
  }

  // ---- internals ----

  async offer(id) {
    const entry = this.makePeer(id);
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    this.sendTo(id, { t: 'call-offer', sdp: entry.pc.localDescription.sdp });
  }

  makePeer(id) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.dataset.peer = id;
    this.audioHost.append(audio);
    const entry = { pc, audio, pending: [] };
    this.pcs.set(id, entry);

    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
    pc.onicecandidate = (e) => { if (e.candidate) this.sendTo(id, { t: 'call-ice', c: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.closePeer(id);
      this.onChange();
    };
    return entry;
  }

  async flush(entry) {
    for (const c of entry.pending.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
  }

  closePeer(id) {
    const entry = this.pcs.get(id);
    if (!entry) return;
    entry.pc.onconnectionstatechange = null;
    entry.pc.close();
    entry.audio.srcObject = null;
    entry.audio.remove();
    this.pcs.delete(id);
  }

  /** Connection state for each person we're in a call with. */
  states() {
    return [...this.pcs].map(([id, { pc }]) => ({ id, state: pc.connectionState }));
  }
}
