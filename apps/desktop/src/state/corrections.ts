export interface AliasMerge {
  from: string;
  to: string;
}

export interface GenderOverride {
  characterId: string;
  gender: string;
}

export interface VoiceOverride {
  characterId: string;
  voiceId: string;
}

export interface CorrectionSet {
  aliasMerges: AliasMerge[];
  genderOverrides: GenderOverride[];
  voiceOverrides: VoiceOverride[];
}

export interface CorrectionState extends CorrectionSet {
  dirty: boolean;
  savedCorrections: CorrectionSet | null;
  affectedChapters: string[];
}

export function createCorrectionsStore() {
  let state: CorrectionState = {
    aliasMerges: [],
    genderOverrides: [],
    voiceOverrides: [],
    dirty: false,
    savedCorrections: null,
    affectedChapters: [],
  };

  const listeners = new Set<() => void>();

  function notify() {
    for (const fn of listeners) fn();
  }

  return {
    get(): CorrectionState {
      return state;
    },

    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    addMerge(merge: AliasMerge) {
      state = {
        ...state,
        aliasMerges: [...state.aliasMerges.filter(m => m.from !== merge.from), merge],
        dirty: true,
      };
      notify();
    },

    setGender(characterId: string, gender: string) {
      state = {
        ...state,
        genderOverrides: [
          ...state.genderOverrides.filter(o => o.characterId !== characterId),
          { characterId, gender },
        ],
        dirty: true,
      };
      notify();
    },

    setVoice(characterId: string, voiceId: string) {
      state = {
        ...state,
        voiceOverrides: [
          ...state.voiceOverrides.filter(o => o.characterId !== characterId),
          { characterId, voiceId },
        ],
        dirty: true,
      };
      notify();
    },

    markSaved(affectedChapters: string[]) {
      const { dirty: _, savedCorrections: __, affectedChapters: ___, ...corrections } = state;
      state = {
        ...state,
        dirty: false,
        savedCorrections: corrections,
        affectedChapters,
      };
      notify();
    },

    reset() {
      state = {
        aliasMerges: [],
        genderOverrides: [],
        voiceOverrides: [],
        dirty: false,
        savedCorrections: null,
        affectedChapters: [],
      };
      notify();
    },
  };
}
