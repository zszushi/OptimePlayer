// @ts-check
const fs = require("fs");
const vm = require("vm");
const { spawn } = require("child_process");

const FPS = 60;
const WIDTH = 1920;
const HEIGHT = 1080;

const toLoad = ["./OptimePlayer/OptimePlayer.js"];

for (let i = 0; i < toLoad.length; i++) {
  let data = fs.readFileSync(toLoad[i]);
  const script = new vm.Script(data.toString());
  script.runInThisContext();
}

// Helper function for clamping values
/**
 * @param {number} val
 * @param {number} min
 * @param {number} max
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Mono WAV encoder for single-track export
 */
class MonoWavEncoder {
  /**
   * @param {number} sampleRate
   * @param {number} bits
   */
  constructor(sampleRate, bits) {
    this.sampleRate = sampleRate;
    this.bits = bits;

    if (bits % 8 !== 0) {
      throw new Error("MonoWavEncoder: bits not multiple of 8:" + bits);
    }
  }

  recordBuffer = new Uint8ClampedArray(32);
  recordBufferAt = 0;

  /**
   * @param {number} sample - mono sample in range [-1, 1]
   */
  addSample(sample) {
    if (this.recordBufferAt + 2 > this.recordBuffer.length) {
      const oldBuf = this.recordBuffer;
      this.recordBuffer = new Uint8ClampedArray(this.recordBufferAt * 2);
      this.recordBuffer.set(oldBuf);
    }

    switch (this.bits) {
      case 8:
        this.recordBuffer[this.recordBufferAt++] = clamp(
          Math.round(((sample + 1) / 2) * 255),
          0,
          255,
        );
        break;
      case 16:
        const out_16bit = clamp(Math.round(sample * 32767), -32768, 32767);
        this.recordBuffer[this.recordBufferAt++] = out_16bit & 0xff;
        this.recordBuffer[this.recordBufferAt++] = (out_16bit >> 8) & 0xff;
        break;
    }
  }

  encode() {
    // Allocate exactly enough for a WAV header
    const wave = new Uint8Array(this.recordBufferAt + 44);

    // RIFF header
    wave[0] = 0x52;
    wave[1] = 0x49;
    wave[2] = 0x46;
    wave[3] = 0x46;

    const size = wave.length - 8;
    wave[4] = (size >> 0) & 0xff;
    wave[5] = (size >> 8) & 0xff;
    wave[6] = (size >> 16) & 0xff;
    wave[7] = (size >> 24) & 0xff;

    // WAVE
    wave[8] = 0x57;
    wave[9] = 0x41;
    wave[10] = 0x56;
    wave[11] = 0x45;

    // Subchunk1ID "fmt "
    wave[12] = 0x66;
    wave[13] = 0x6d;
    wave[14] = 0x74;
    wave[15] = 0x20;

    // Subchunk1Size
    wave[16] = 16;
    wave[17] = 0;
    wave[18] = 0;
    wave[19] = 0;

    // AudioFormat
    wave[20] = 1;
    wave[21] = 0;

    // 1 channel (mono)
    wave[22] = 1;
    wave[23] = 0;

    // Sample rate
    wave[24] = (this.sampleRate >> 0) & 0xff;
    wave[25] = (this.sampleRate >> 8) & 0xff;
    wave[26] = (this.sampleRate >> 16) & 0xff;
    wave[27] = (this.sampleRate >> 24) & 0xff;

    // ByteRate
    // SampleRate * NumChannels * BitsPerSample/8
    const byteRate = this.sampleRate * 1 * (this.bits / 8);
    wave[28] = (byteRate >> 0) & 0xff;
    wave[29] = (byteRate >> 8) & 0xff;
    wave[30] = (byteRate >> 16) & 0xff;
    wave[31] = (byteRate >> 24) & 0xff;

    // BlockAlign
    // NumChannels * BitsPerSample / 8
    const blockAlign = 1 * (this.bits / 8);
    wave[32] = (blockAlign >> 0) & 0xff;
    wave[33] = (blockAlign >> 8) & 0xff;

    // BitsPerSample
    wave[34] = this.bits;
    wave[35] = 0;

    // Subchunk2ID "data"
    wave[36] = 0x64;
    wave[37] = 0x61;
    wave[38] = 0x74;
    wave[39] = 0x61;

    // Data Size (NumSamples * NumChannels * BitsPerSample/8)
    wave[40] = (this.recordBufferAt >> 0) & 0xff;
    wave[41] = (this.recordBufferAt >> 8) & 0xff;
    wave[42] = (this.recordBufferAt >> 16) & 0xff;
    wave[43] = (this.recordBufferAt >> 24) & 0xff;

    for (let i = 0; i < this.recordBufferAt; i++) {
      wave[44 + i] = this.recordBuffer[i];
    }

    return wave;
  }
}

async function renderTrackSeq(sdat, id, outFile, preview) {
  const SAMPLE_RATE = 32768;

  let controller = new Controller(SAMPLE_RATE);
  controller.loadSseq(sdat, id);

  console.log("Rendering SSEQ Id:" + id);

  let sample = 0;
  let fadingOut = false;
  let fadeoutStartSample = 0;
  let loop = 0;

  let timer = 0;
  let playing = true;
  let fadeoutLength = 0.1; // in seconds

  let frameTimer = 0;
  let frames = 0;

  g_currentlyPlayingSdat = sdat;
  g_currentController = controller;
  currentFsVisController = null;
  g_currentlyPlayingId = id;

  // Track which tracks have activity
  let trackHasActivity = new Array(16).fill(false);
  
  // Encoders for each track
  let trackEncoders = [];
  for (let i = 0; i < 16; i++) {
    trackEncoders[i] = new MonoWavEncoder(SAMPLE_RATE, 16);
  }

  let clipping = 0;

  // keep it under 480 seconds
  while (playing && sample < SAMPLE_RATE * 480) {
    // nintendo DS clock speed
    timer += 33513982;
    while (timer >= 64 * 2728 * SAMPLE_RATE) {
      timer -= 64 * 2728 * SAMPLE_RATE;

      controller.tick();
    }

    if (controller.jumps > 0) {
      controller.jumps = 0;
      loop++;

      if (loop === 2) {
        fadeoutLength = 5;
        controller.fadingStart = true;
      }
    }

    if (controller.fadingStart) {
      controller.fadingStart = false;
      fadingOut = true;
      fadeoutStartSample = sample + SAMPLE_RATE * 2;
      console.log("Starting fadeout at sample: " + fadeoutStartSample);
    }

    let fadeoutVolMul = 1;

    if (fadingOut) {
      let fadeoutSample = sample - fadeoutStartSample;
      if (fadeoutSample >= 0) {
        let fadeoutTime = fadeoutSample / SAMPLE_RATE;

        let ratio = fadeoutTime / fadeoutLength;

        fadeoutVolMul = 1 - ratio;

        if (fadeoutVolMul <= 0) {
          playing = false;
        }
      }
    }

    // Process each track individually
    for (let i = 0; i < 16; i++) {
      if (g_trackEnables[i]) {
        let synth = controller.synthesizers[i];
        synth.nextSample();
        
        // Get the track's output (combined L+R as mono)
        let valL = synth.valL * 0.4 * fadeoutVolMul;
        let valR = synth.valR * 0.4 * fadeoutVolMul;
        
        // Check if this track has any significant activity
        if (Math.abs(valL) > 0.001 || Math.abs(valR) > 0.001) {
          trackHasActivity[i] = true;
        }
        
        // Combine L and R to mono (simple average)
        let monoSample = (valL + valR) * 0.5;
        
        // Add to this track's encoder
        trackEncoders[i].addSample(monoSample);
      }
    }

    sample++;
  }

  console.log("\nExporting individual tracks:");
  let exportedCount = 0;
  for (let i = 0; i < 16; i++) {
    if (trackHasActivity[i]) {
      const trackFileName = `${outFile}_track${i.toString().padStart(2, '0')}.wav`;
      fs.writeFileSync(trackFileName, trackEncoders[i].encode());
      console.log(`  Track ${i}: ${trackFileName}`);
      exportedCount++;
    } else {
      console.log(`  Track ${i}: (skipped - no activity)`);
    }
  }
  
  console.log(`\nExported ${exportedCount} of 16 tracks.`);
}

if (process.argv.length < 4) {
  console.log(
    "Arguments: <path to DS ROM> <name of SSEQ to play> [output file base name]",
  );
  process.exit(1);
}
const dsRomPath = process.argv[2];
const sseqName = process.argv[3];
let outFile = process.argv[4];

if (outFile === undefined) {
  outFile = sseqName;
}
let sdats = Sdat.loadAllFromDataView(
  new DataView(fs.readFileSync(dsRomPath).buffer),
);
let sseqId = null;
let sdatWithSeq = null;
for (let sdat of sdats) {
  if (sdat.sseqNameIdDict.has(sseqName)) {
    sdatWithSeq = sdat;
    sseqId = sdat.sseqNameIdDict.get(sseqName);
  }
}

if (sseqId) {
  renderTrackSeq(sdatWithSeq, sseqId, outFile, false);
} else {
  console.log(`SSEQ "${sseqName}" not found in DS ROM`);
}
