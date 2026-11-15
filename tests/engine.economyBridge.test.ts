import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('pont C++ : économie v1.5 (#165/#166/#167)', () => {
  const bridge = source('engine/bridge/ottd_bridge.cpp');

  it('expose les commandes de prêt et d’autorité locale', () => {
    expect(bridge).toContain('CMD_INCREASE_LOAN');
    expect(bridge).toContain('CMD_DECREASE_LOAN');
    expect(bridge).toContain('CMD_DO_TOWN_ACTION');
    expect(bridge).toContain('LoanCommand::Amount');
    expect(bridge).toContain('TownAction::RoadRebuild');
    expect(bridge).toContain('TownAction::FundBuildings');
  });

  it('sérialise inflation, prêts, autorité locale, subventions et service', () => {
    expect(bridge).toContain('\\"inflation\\"');
    expect(bridge).toContain('\\"interestRate\\"');
    expect(bridge).toContain('c->GetMaxLoan()');
    expect(bridge).toContain('months_of_bankruptcy');
    expect(bridge).toContain('\\"authority\\"');
    expect(bridge).toContain('\\"actions\\"');
    expect(bridge).toContain('\\"subsidies\\"');
    expect(bridge).toContain('Subsidy::Iterate()');
    expect(bridge).toContain('\\"serviceRate\\"');
    expect(bridge).toContain('\\"accepts\\"');
  });

  it('dispatche les types finance et town_action', () => {
    expect(bridge).toMatch(/type == "finance"/);
    expect(bridge).toMatch(/type == "town_action"/);
    expect(bridge).toContain('DispatchFinance');
    expect(bridge).toContain('DispatchTownAction');
  });

  it('le scénario d’intégration couvre prêt et action municipale', () => {
    const commands = source('engine/scripts/commands.mjs');
    expect(commands).toContain("type: 'finance'");
    expect(commands).toContain("type: 'town_action'");
    expect(commands).toContain('increase_loan');
    expect(commands).toContain('decrease_loan');
    expect(commands).toContain('fund_roads');
    expect(commands).toContain('subsidies');
  });
});
