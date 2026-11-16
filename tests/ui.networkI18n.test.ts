import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOGS, TRANSLATION_KEYS, resetI18n, setLanguage, t } from '../src/ui/i18n';
import {
  checkLateJoinCompatibility,
  describeHostJoin,
  describeLateJoinState,
  joinRejectMessage,
  playerCountLabel,
  type HostJoinView,
} from '../src/ui/netjoin';
import { readNetworkParams } from '../src/ui/netlobby';
import { inspectSaveBytes } from '../src/ui/saveFormat';
import { MemorySaveBackend, SaveStore } from '../src/ui/saveStore';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function source(relative: string): string {
  return readFileSync(join(root, 'src/ui', relative), 'utf8');
}

const hostView: HostJoinView = {
  autoAdmit: false,
  pending: [],
  windows: [],
  outcome: null,
  players: [{ player: 0, name: 'Hôte' }],
};

afterEach(() => {
  resetI18n();
});

describe('catalogue réseau (#171)', () => {
  it('expose toutes les clés des écrans réseau en FR et EN', () => {
    const prefixes = [
      'mp.',
      'lobby.',
      'join.',
      'late.',
      'net.params.',
      'net.controlsLocked',
      'save.error.',
    ];
    const keys = TRANSLATION_KEYS.filter((key) =>
      prefixes.some((prefix) => key === prefix || key.startsWith(prefix)),
    );
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      expect(CATALOGS.fr[key]?.trim(), `FR ${key}`).not.toBe('');
      expect(CATALOGS.en[key]?.trim(), `EN ${key}`).not.toBe('');
    }
  });

  it('traduit réellement les écrans réseau en anglais', () => {
    setLanguage('en', { storage: null });
    expect(t('mp.title')).toBe('Play online');
    expect(t('lobby.ready')).toBe('I’m ready');
    expect(t('join.title')).toBe('Join game in progress');
    expect(t('late.title')).toBe('Late joiners');
    expect(t('join.reject.full')).toContain('full');
    expect(t('save.error.quota')).toContain('storage');
  });
});

describe('messages réseau localisés (#171)', () => {
  it('traduit les refus de join et les étapes du client', () => {
    setLanguage('en', { storage: null });
    expect(joinRejectMessage('full')).toContain('full');
    expect(
      checkLateJoinCompatibility(
        {
          settings: {
            engine: 'mock',
            mapSize: 256,
            climate: 'temperate',
            difficulty: 'normal',
            startingMoney: 100000,
            maxPlayers: 4,
          },
          engineBuild: 'other',
        },
        'expected-build',
      ),
    ).toContain('Engine mismatch');

    const transfer = describeLateJoinState({
      stage: 'transfer',
      message: '',
      tone: 'info',
      progress: 0,
      received: 3,
      total: 12,
    });
    expect(transfer.title).toBe('Receiving the save');
    expect(transfer.message).toContain('3/12');
  });

  it('traduit le panneau hôte et les compteurs', () => {
    setLanguage('en', { storage: null });
    const idle = describeHostJoin(hostView);
    expect(idle.primaryLabel).toBe('Open to late joiners');
    expect(idle.text).toContain('No join request');
    expect(playerCountLabel(hostView)).toBe('1 player in the game');
    setLanguage('fr', { storage: null });
    expect(describeHostJoin(hostView).text).toContain('Aucune demande');
    expect(playerCountLabel(hostView)).toBe('1 joueur dans la partie');
  });

  it('traduit les avertissements d’URL réseau', () => {
    setLanguage('en', { storage: null });
    expect(readNetworkParams('?room=bad!').warning).toBe('Invalid invite link.');
    expect(readNetworkParams('?net=autre').warning).toContain('Unknown network mode');
  });
});

describe('erreurs de sauvegarde localisées (#171)', () => {
  it('traduit les erreurs de format en anglais', () => {
    setLanguage('en', { storage: null });
    expect(() => inspectSaveBytes(new TextEncoder().encode('bonjour'))).toThrow(/Unknown format/);
    expect(() => inspectSaveBytes(new Uint8Array(0))).toThrow(/Empty file/);
  });

  it('traduit les erreurs du stockage en anglais', async () => {
    setLanguage('en', { storage: null });
    const store = new SaveStore(new MemorySaveBackend());
    await expect(store.save({ bytes: new Uint8Array(0), engine: 'mock' })).rejects.toThrow(
      'Empty save: nothing to write.',
    );
  });
});

describe('absence de texte français en dur dans les écrans réseau', () => {
  it('n’a plus de libellé accentué dans les écrans et panneaux', () => {
    const files = [
      'screens/MultiplayerScreen.ts',
      'screens/LobbyScreen.ts',
      'screens/JoinScreen.ts',
      'lateJoinPanel.ts',
      'netjoin.ts',
    ];
    const accentedLiteral =
      /(?:text|title|placeholder|'aria-label'|'aria-labelledby')\s*:\s*'[^']*[éèêàçùûîôœ][^']*'|(?:textContent|warning|reason|error|message)\s*=\s*'[^']*[éèêàçùûîôœ][^']*'|button\('[^']*[éèêàçùûîôœ][^']*'/;
    const offenders: string[] = [];
    for (const relative of files) {
      for (const line of source(relative).split('\n')) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
        if (accentedLiteral.test(line)) offenders.push(`${relative}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('n’utilise plus les libellés réseau français codés en dur', () => {
    const netlobby = source('netlobby.ts');
    expect(netlobby).not.toMatch(/ENGINE_LABELS|CLIMATE_LABELS|DIFFICULTY_LABELS/);
    expect(netlobby).toContain("'lobby.engine.wasm'");
    expect(netlobby).toContain("t('net.controlsLocked')");
    const main = readFileSync(join(root, 'src/main.ts'), 'utf8');
    expect(main).not.toContain("'Salon P2P · Trystero / relais Nostr'");
    expect(main).toContain("t('menu.multiplayer.relayNote')");
  });
});
