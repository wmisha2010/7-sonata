// Procedural music synthesis: renders a short melodic loop to a WAV blob URL.
// Keeps the demo player fully self-contained (no external network audio needed).

interface SynthParams {
  rootMidi: number
  progression: number[][]
  bpm: number
  wave: OscillatorType
  duration: number
}

const PROGRESSIONS: number[][][] = [
  // Am - F - C - G (vi - IV - I - V)
  [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],
  // C - Am - F - G (I - vi - IV - V)
  [[48, 52, 55], [57, 60, 64], [53, 57, 60], [55, 59, 62]],
  // Dm - G - Am - F
  [[50, 53, 57], [55, 59, 62], [57, 60, 64], [53, 57, 60]],
  // Em - C - G - D
  [[52, 55, 59], [48, 52, 55], [55, 59, 62], [50, 54, 57]],
]

const WAVES: OscillatorType[] = ["triangle", "sine", "sawtooth", "square"]

// Deterministic hash -> uint from a string
function hashSeed(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function makeRng(seed: string) {
  let h = hashSeed(seed)
  return () => {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    return (h >>> 0) / 0xffffffff
  }
}

export function paramsFromSeed(seed: string): SynthParams {
  const rand = makeRng(seed)
  const progression = PROGRESSIONS[Math.floor(rand() * PROGRESSIONS.length)]
  const rootMidi = [45, 50, 52, 57][Math.floor(rand() * 4)] // bass-ish roots
  const bpm = [70, 84, 96, 110][Math.floor(rand() * 4)]
  const wave = WAVES[Math.floor(rand() * 2)] // prefer triangle/sine for softer tone
  return { rootMidi, progression, bpm, wave, duration: 18 }
}

function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12)
}

async function renderToBuffer(
  params: SynthParams
): Promise<AudioBuffer> {
  const sampleRate = 22050
  const duration = params.duration
  const length = Math.ceil(sampleRate * duration)
  const Ctx =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext
  const offline = new Ctx(1, length, sampleRate)

  // Master chain: source -> lowpass -> master gain -> destination
  const master = offline.createGain()
  master.gain.value = 0.5
  master.connect(offline.destination)

  const filter = offline.createBiquadFilter()
  filter.type = "lowpass"
  filter.frequency.value = 2600
  filter.Q.value = 0.6
  filter.connect(master)

  // gentle reverb-ish delay
  const delay = offline.createDelay(1.0)
  delay.delayTime.value = 0.28
  const feedback = offline.createGain()
  feedback.gain.value = 0.22
  const wet = offline.createGain()
  wet.gain.value = 0.18
  filter.connect(delay)
  delay.connect(feedback)
  feedback.connect(delay)
  delay.connect(wet)
  wet.connect(master)

  const rand = makeRng(params.rootMidi + ":" + params.bpm)

  const pluck = (
    freq: number,
    start: number,
    dur: number,
    peak: number,
    type: OscillatorType
  ) => {
    if (start < 0 || start >= duration) return
    const osc = offline.createOscillator()
    osc.type = type
    osc.frequency.value = freq
    // subtle vibrato
    const lfo = offline.createOscillator()
    lfo.frequency.value = 5 + rand() * 2
    const lfoGain = offline.createGain()
    lfoGain.gain.value = freq * 0.004
    lfo.connect(lfoGain)
    lfoGain.connect(osc.frequency)

    const g = offline.createGain()
    g.gain.setValueAtTime(0.0001, start)
    g.gain.linearRampToValueAtTime(peak, start + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur)

    osc.connect(g)
    g.connect(filter)
    osc.start(start)
    lfo.start(start)
    osc.stop(start + dur + 0.05)
    lfo.stop(start + dur + 0.05)
  }

  const padChord = (notes: number[], start: number, dur: number) => {
    for (const n of notes) {
      const osc = offline.createOscillator()
      osc.type = "sawtooth"
      osc.frequency.value = midiToFreq(n)
      const g = offline.createGain()
      g.gain.setValueAtTime(0.0001, start)
      g.gain.linearRampToValueAtTime(0.04, start + 0.15)
      g.gain.setValueAtTime(0.04, start + dur - 0.3)
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
      osc.connect(g)
      g.connect(filter)
      osc.start(start)
      osc.stop(start + dur + 0.05)
    }
  }

  const beat = 60 / params.bpm
  const chordDur = beat * 4 // one chord per bar (4 beats)
  let t = 0
  let progIndex = 0
  while (t < duration) {
    const chord = params.progression[progIndex % params.progression.length]
    const root = chord[0]
    // bass
    pluck(
      midiToFreq(root - 12),
      t,
      chordDur * 0.95,
      0.22,
      "sine"
    )
    // pad
    padChord(chord, t, chordDur * 0.98)
    // arpeggio (8th notes, up-down pattern)
    const pattern = [chord[0], chord[1], chord[2], chord[1], chord[2], chord[1], chord[0], chord[1]]
    const step = chordDur / pattern.length
    for (let i = 0; i < pattern.length; i++) {
      const note = pattern[i] + 12 // one octave up
      const jitter = (rand() - 0.5) * 0.01
      pluck(midiToFreq(note), t + i * step + jitter, step * 1.8, 0.13, params.wave)
    }
    // occasional sparkle melody note
    if (rand() > 0.5) {
      const sparkle = chord[Math.floor(rand() * chord.length)] + 24
      pluck(midiToFreq(sparkle), t + beat * (2 + rand()), beat * 1.5, 0.08, "sine")
    }

    t += chordDur
    progIndex++
  }

  return offline.startRendering()
}

function audioBufferToWavBlobUrl(buffer: AudioBuffer): string {
  const numCh = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const bytesPerSample = 2
  const dataLength = buffer.length * numCh * bytesPerSample
  const headerLength = 44
  const totalLength = dataLength + headerLength
  const ab = new ArrayBuffer(totalLength)
  const view = new DataView(ab)
  let offset = 0

  const writeString = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i))
  }
  const writeU32 = (v: number) => {
    view.setUint32(offset, v, true)
    offset += 4
  }
  const writeU16 = (v: number) => {
    view.setUint16(offset, v, true)
    offset += 2
  }

  writeString("RIFF")
  writeU32(totalLength - 8)
  writeString("WAVE")
  writeString("fmt ")
  writeU32(16)
  writeU16(1) // PCM
  writeU16(numCh)
  writeU32(sampleRate)
  writeU32(sampleRate * numCh * bytesPerSample)
  writeU16(numCh * bytesPerSample)
  writeU16(16) // bits per sample
  writeString("data")
  writeU32(dataLength)

  const channels: Float32Array[] = []
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c))
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]))
      s = s < 0 ? s * 0x8000 : s * 0x7fff
      view.setInt16(offset, s, true)
      offset += 2
    }
  }

  return URL.createObjectURL(new Blob([ab], { type: "audio/wav" }))
}

export async function generateTrackWav(seed: string): Promise<string> {
  const params = paramsFromSeed(seed)
  const buffer = await renderToBuffer(params)
  return audioBufferToWavBlobUrl(buffer)
}
