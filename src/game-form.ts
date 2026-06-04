/**
 * New-game configuration form: shared wiring for every place a player picks a
 * board mode, size, scoring, komi, and time control.
 *
 * Three forms reuse this with different element-id prefixes:
 *   - lobby new-game form        (`go3d-*`)        — online create + local
 *   - pre-login local-setup form (`go3d-ls-*`)     — plugin auth screen
 *   - standalone GitHub Pages    (`go3d-ls-*`)     — same ids as local-setup
 *
 * Keeping the toggles + value-reading in one place means the paths can't drift.
 */

// Normalised settings read off any of the game-config forms.
export interface GameFormSettings {
  board_size:    number;
  mode:          'cube' | 'stack' | 'sphere';
  scoring_mode:  'chinese' | 'japanese';
  komi:          number;
  time_control:  string;
  time_settings: Record<string, number> | null;
}

// Element IDs for one game-config form instance.
export interface GameFormIds {
  form:              string;
  timeControlSelect: string;
  timeSettings:      string;
  byoyomiExtra:      string;
  fischerExtra:      string;
  modeSelect:        string;
  cubeWrap:          string;
  sphereWrap:        string;
  sphereSize:        string;
  sphereFreq:        string;
  cubeSize:          string;
  cubeCustom:        string;
}

export const LOBBY_FORM_IDS: GameFormIds = {
  form:              'go3d-new-game-form',
  timeControlSelect: 'go3d-time-control-select',
  timeSettings:      'go3d-time-settings',
  byoyomiExtra:      'go3d-byoyomi-extra',
  fischerExtra:      'go3d-fischer-extra',
  modeSelect:        'go3d-mode-select',
  cubeWrap:          'go3d-cube-size-wrap',
  sphereWrap:        'go3d-sphere-size-wrap',
  sphereSize:        'go3d-sphere-size',
  sphereFreq:        'go3d-sphere-freq',
  cubeSize:          'go3d-cube-size',
  cubeCustom:        'go3d-cube-custom',
};

// Used by both the plugin's pre-login setup screen and the standalone page,
// which share the same `go3d-ls-*` markup.
export const LOCAL_SETUP_FORM_IDS: GameFormIds = {
  form:              'go3d-ls-form',
  timeControlSelect: 'go3d-ls-time-control-select',
  timeSettings:      'go3d-ls-time-settings',
  byoyomiExtra:      'go3d-ls-byoyomi-extra',
  fischerExtra:      'go3d-ls-fischer-extra',
  modeSelect:        'go3d-ls-mode-select',
  cubeWrap:          'go3d-ls-cube-size-wrap',
  sphereWrap:        'go3d-ls-sphere-size-wrap',
  sphereSize:        'go3d-ls-sphere-size',
  sphereFreq:        'go3d-ls-sphere-freq',
  cubeSize:          'go3d-ls-cube-size',
  cubeCustom:        'go3d-ls-cube-custom',
};

/**
 * Wire one game-config form's show/hide toggles + size clamps, and return a
 * reader that normalises its current values into GameFormSettings.
 */
export function bindGameForm(ids: GameFormIds): () => GameFormSettings {
  const tcSel = document.getElementById(ids.timeControlSelect) as HTMLSelectElement;
  const tsDiv = document.getElementById(ids.timeSettings)!;
  const bDiv  = document.getElementById(ids.byoyomiExtra)!;
  const fDiv  = document.getElementById(ids.fischerExtra)!;
  tcSel.addEventListener('change', () => {
    tsDiv.style.display = tcSel.value === 'none' ? 'none' : '';
    bDiv.style.display  = tcSel.value === 'byoyomi'  ? '' : 'none';
    fDiv.style.display  = tcSel.value === 'fischer'  ? '' : 'none';
  });

  // Mode selector: cube/stack use the cube size dropdown; sphere swaps in the
  // geodesic size selector (presets + a custom frequency input).
  const modeSel    = document.getElementById(ids.modeSelect) as HTMLSelectElement;
  const cubeWrap   = document.getElementById(ids.cubeWrap)!;
  const sphereWrap = document.getElementById(ids.sphereWrap)!;
  const sphereSel  = document.getElementById(ids.sphereSize) as HTMLSelectElement;
  const sphereFreq = document.getElementById(ids.sphereFreq) as HTMLInputElement;
  const cubeSel    = document.getElementById(ids.cubeSize)   as HTMLSelectElement;
  const cubeCustom = document.getElementById(ids.cubeCustom) as HTMLInputElement;
  modeSel.addEventListener('change', () => {
    const isSphere = modeSel.value === 'sphere';
    cubeWrap.style.display   = isSphere ? 'none' : '';
    sphereWrap.style.display = isSphere ? '' : 'none';
  });
  sphereSel.addEventListener('change', () => {
    sphereFreq.style.display = sphereSel.value === 'custom' ? '' : 'none';
  });
  cubeSel.addEventListener('change', () => {
    cubeCustom.style.display = cubeSel.value === 'custom' ? '' : 'none';
  });
  // Live-clamp the custom size inputs to their valid range so a typed value
  // can never exceed the max (cube 2–19, sphere frequency 2–8).
  const clampInput = (el: HTMLInputElement, lo: number, hi: number) => () => {
    const v = Number(el.value);
    if (Number.isFinite(v) && v > hi) el.value = String(hi);
    else if (Number.isFinite(v) && v < lo && el.value !== '') el.value = String(lo);
  };
  cubeCustom.addEventListener('change', clampInput(cubeCustom, 2, 19));
  sphereFreq.addEventListener('change', clampInput(sphereFreq, 2, 8));

  return (): GameFormSettings => {
    const form = document.getElementById(ids.form) as HTMLFormElement;
    const fd   = new FormData(form);
    const tc   = fd.get('time_control') as string;
    const mode = fd.get('mode') as string;
    // Sphere games store the geodesic frequency in board_size; cube/stack use
    // the lattice edge length. Both size selectors live outside the form (no
    // name attr) so we read them directly, resolving the "custom" preset.
    let boardSize: number;
    if (mode === 'sphere') {
      boardSize = sphereSel.value === 'custom'
        ? Math.max(2, Math.min(8, Number(sphereFreq.value)))
        : Number(sphereSel.value);
    } else {
      boardSize = cubeSel.value === 'custom'
        ? Math.max(2, Math.min(19, Number(cubeCustom.value)))
        : Number(cubeSel.value);
    }
    let timeSettings: Record<string, number> | null = null;
    if (tc !== 'none') {
      timeSettings = { main_time_s: Number(fd.get('main_time_s')) };
      if (tc === 'byoyomi') {
        timeSettings.byoyomi_periods = Number(fd.get('byoyomi_periods'));
        timeSettings.byoyomi_time_s  = Number(fd.get('byoyomi_time_s'));
      }
      if (tc === 'fischer') {
        timeSettings.fischer_increment_s = Number(fd.get('fischer_increment_s'));
      }
    }
    return {
      board_size:   boardSize,
      mode:         mode as 'cube' | 'stack' | 'sphere',
      scoring_mode: (fd.get('scoring_mode') as string) === 'japanese' ? 'japanese' : 'chinese',
      komi:         Number(fd.get('komi')),
      time_control: tc,
      time_settings: timeSettings,
    };
  };
}
