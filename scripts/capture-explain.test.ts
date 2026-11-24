import {
  BaselineEntry,
  checkRegressionAlarm,
} from './capture-explain';

describe('checkRegressionAlarm', () => {
  const baseline: BaselineEntry = {
    total_cost: 15.5,
    plan_type: 'Index Scan',
    index_name: 'idx_sessions_active_user_id',
  };

  it('does not alarm when the observed cost is below the threshold', () => {
    expect(() =>
      checkRegressionAlarm('activeSessionLookupByUserId', 30.99, baseline),
    ).not.toThrow();
  });

  it('alarms when the observed cost is over the threshold', () => {
    expect(() =>
      checkRegressionAlarm('activeSessionLookupByUserId', 31.01, baseline),
    ).toThrow(
      'Regression Alarm: Plan cost for "activeSessionLookupByUserId" (31.01) ' +
      'exceeds baseline * 2 (31.00)',
    );
  });

  it('alarms for a missing baseline', () => {
    expect(() =>
      checkRegressionAlarm('activeSessionLookupByUserId', 20, undefined),
    ).toThrow(
      'Regression Alarm: Missing baseline for "activeSessionLookupByUserId". ' +
      'Cannot verify the observed plan cost.',
    );
  });

  it('does not alarm when observed cost is exactly at the threshold', () => {
    expect(() =>
      checkRegressionAlarm('activeSessionLookupByUserId', 31, baseline),
    ).not.toThrow();
  });

  it('alarms just above the exact threshold', () => {
    expect(() =>
      checkRegressionAlarm('activeSessionLookupByUserId', 31.001, baseline),
    ).toThrow(/Regression Alarm/);
  });

  it('supports a custom regression factor at its exact boundary', () => {
    expect(() =>
      checkRegressionAlarm('countActiveSessions', 46.5, baseline, 3),
    ).not.toThrow();
  });

  it('alarms above a custom regression factor', () => {
    expect(() =>
      checkRegressionAlarm('countActiveSessions', 46.501, baseline, 3),
    ).toThrow(/exceeds baseline \* 3 \(46\.50\)/);
  });

  it('includes plan metadata in the alarm and handles a missing index name', () => {
    const seqScanBaseline: BaselineEntry = {
      total_cost: 10,
      plan_type: 'Seq Scan',
    };

    expect(() =>
      checkRegressionAlarm('sessionLookupByTokenHash', 21, seqScanBaseline),
    ).toThrow(
      /Baseline plan_type="Seq Scan", index="none"/,
    );
  });
});
