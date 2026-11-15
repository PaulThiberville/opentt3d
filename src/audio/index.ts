/** Point d'entrée public du moteur audio procédural. */

export { AudioEngine, MUSIC_LEVEL, volumesFromSettings } from './AudioEngine';
export type {
  AudioEngineOptions,
  AudioEngineState,
  AudioVolumes,
  ListenerState,
  PlayOptions,
} from './AudioEngine';
export { AudioDirector } from './director';
export type { AudioSink, DirectorOptions } from './director';
export { SessionAudio } from './sessionAudio';
export type { SessionAudioOptions } from './sessionAudio';
export {
  DEFAULT_AUDIO_PREFERENCES,
  AUDIO_PREFERENCES_KEY,
  loadAudioPreferences,
  sanitizeAudioPreferences,
  saveAudioPreferences,
} from './preferences';
export type { AudioPreferences, AudioStorageLike } from './preferences';
export { SOUND_IDS, UI_SOUNDS, isUiSound } from './soundIds';
export type { SoundId } from './soundIds';
export {
  ambienceDensity,
  ambienceFromSnapshot,
  gainForDistance,
  panForOffset,
  soundForCommand,
  soundForNotification,
} from './mapping';
export type { AmbienceEnvironment, NotifyKind } from './mapping';
export { DEFAULT_THROTTLE_MS, SoundThrottle } from './throttle';
export { installAudioUi } from './ui';
export type { AudioUiOptions } from './ui';
export { createDefaultAudioContext } from './context';
export type { AudioContextLike } from './context';
