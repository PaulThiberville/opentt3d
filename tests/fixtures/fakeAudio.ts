/**
 * Faux contexte WebAudio pour les tests Node.
 *
 * Il expose les mêmes interfaces structurelles que `src/audio/context.ts` et
 * enregistre les nœuds créés afin de vérifier volumes, mute, suspend et dispose
 * sans dépendre d'un navigateur.
 */

import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadFilterNodeLike,
  GainNodeLike,
  OscillatorNodeLike,
  StereoPannerNodeLike,
} from '../../src/audio/context';

export class FakeParam implements AudioParamLike {
  value: number;
  readonly calls: { method: string; value: number; time: number }[] = [];

  constructor(value = 1) {
    this.value = value;
  }

  setValueAtTime(value: number, startTime: number): void {
    this.value = value;
    this.calls.push({ method: 'setValueAtTime', value, time: startTime });
  }

  linearRampToValueAtTime(value: number, endTime: number): void {
    this.value = value;
    this.calls.push({ method: 'linearRamp', value, time: endTime });
  }

  exponentialRampToValueAtTime(value: number, endTime: number): void {
    this.value = value;
    this.calls.push({ method: 'exponentialRamp', value, time: endTime });
  }

  setTargetAtTime(value: number, startTime: number, timeConstant: number): void {
    this.value = value;
    this.calls.push({ method: 'setTargetAtTime', value, time: timeConstant });
    void startTime;
  }

  cancelScheduledValues(startTime: number): void {
    this.calls.push({ method: 'cancelScheduledValues', value: 0, time: startTime });
  }
}

export class FakeNode implements AudioNodeLike {
  readonly outputs: AudioNodeLike[] = [];
  disconnected = false;

  connect(destination: AudioNodeLike): void {
    this.outputs.push(destination);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

export class FakeGainNode extends FakeNode implements GainNodeLike {
  readonly gain = new FakeParam(1);
}

export class FakePannerNode extends FakeNode implements StereoPannerNodeLike {
  readonly pan = new FakeParam(0);
}

export class FakeFilterNode extends FakeNode implements BiquadFilterNodeLike {
  type = 'lowpass';
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
}

export class FakeOscillatorNode extends FakeNode implements OscillatorNodeLike {
  type = 'sine';
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
  onended: (() => void) | null = null;
  started = false;
  stopped = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }
}

export class FakeAudioBuffer implements AudioBufferLike {
  readonly data: Float32Array;
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels = 1;

  constructor(length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = new Float32Array(length);
  }

  getChannelData(): Float32Array {
    return this.data;
  }
}

export class FakeBufferSource extends FakeNode implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
  onended: (() => void) | null = null;
  started = false;
  stopped = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }
}

export class FakeAudioContext implements AudioContextLike {
  currentTime = 0;
  readonly sampleRate = 1000;
  state = 'running';
  readonly destination = new FakeNode();
  readonly gains: FakeGainNode[] = [];
  readonly oscillators: FakeOscillatorNode[] = [];
  readonly sources: FakeBufferSource[] = [];
  readonly filters: FakeFilterNode[] = [];
  readonly panners: FakePannerNode[] = [];
  buffersCreated = 0;
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;

  createGain(): GainNodeLike {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): OscillatorNodeLike {
    const oscillator = new FakeOscillatorNode();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createBufferSource(): AudioBufferSourceNodeLike {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }

  createBiquadFilter(): BiquadFilterNodeLike {
    const filter = new FakeFilterNode();
    this.filters.push(filter);
    return filter;
  }

  createStereoPanner(): StereoPannerNodeLike {
    const panner = new FakePannerNode();
    this.panners.push(panner);
    return panner;
  }

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBufferLike {
    this.buffersCreated += 1;
    return new FakeAudioBuffer(length, sampleRate);
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspendCalls += 1;
    this.state = 'suspended';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
    return Promise.resolve();
  }
}

export function createFakeContext(): FakeAudioContext {
  return new FakeAudioContext();
}
