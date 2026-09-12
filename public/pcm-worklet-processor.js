/**
 * pcm-worklet-processor.js
 *
 * AudioWorkletProcessor that runs on the audio rendering thread (not the
 * main thread — unlike the deprecated ScriptProcessorNode, this doesn't
 * block or glitch on UI work). It converts each block of Float32 mic
 * samples to 16-bit signed PCM (LINEAR16, little-endian) and posts the raw
 * bytes back to the main thread, which forwards them to the server as
 * binary WebSocket frames for Google Cloud Speech-to-Text streaming.
 *
 * Loaded via: audioContext.audioWorklet.addModule('/pcm-worklet-processor.js')
 * Used via:   new AudioWorkletNode(audioContext, 'pcm-capture-processor')
 */
class PCMCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channelData = input && input[0];
    if (channelData && channelData.length > 0) {
      const pcm16 = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        // Clamp to [-1, 1] then scale to the full Int16 range.
        const s = Math.max(-1, Math.min(1, channelData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Transfer the underlying buffer (zero-copy) to the main thread.
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
    // Returning true keeps the processor alive for the next audio block.
    return true;
  }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
