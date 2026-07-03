import { describe, expect, it, vi } from 'vitest';
import {
  ALARM_PIPELINE_COUNTER_METRICS,
  ALARM_PIPELINE_LATENCY_METRIC,
  emitCounter,
  emitTiming,
} from '../util/metrics.js';

describe('metrics', () => {
  describe('emitCounter', () => {
    it('prefers an `.info` sink and includes the metric name as both field and message', () => {
      const info = vi.fn();
      emitCounter(
        { info },
        ALARM_PIPELINE_COUNTER_METRICS.ALARMS_RECEIVED,
        { alarm_name: 'CPUHigh', sns_message_id: 'sns-1', trigger_id: 'trigger-1' }
      );

      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        {
          metric: 'alarm_pipeline.alarms_received',
          alarm_name: 'CPUHigh',
          sns_message_id: 'sns-1',
          trigger_id: 'trigger-1',
        },
        'alarm_pipeline.alarms_received'
      );
    });

    it('falls back to a console-like `.log` sink as a single structured JSON string', () => {
      const log = vi.fn();
      emitCounter({ log }, ALARM_PIPELINE_COUNTER_METRICS.SEVERITY_DEFERRED, {
        trigger_id: 'trigger-2',
      });

      expect(log).toHaveBeenCalledTimes(1);
      const [line] = log.mock.calls[0] as [string];
      expect(JSON.parse(line)).toEqual({
        metric: 'alarm_pipeline.severity_deferred',
        trigger_id: 'trigger-2',
      });
    });

    it('emits stable metric names for every documented pipeline stage', () => {
      const info = vi.fn();
      for (const metric of Object.values(ALARM_PIPELINE_COUNTER_METRICS)) {
        emitCounter({ info }, metric);
      }
      const emitted = info.mock.calls.map((call) => (call[0] as { metric: string }).metric);
      expect(emitted).toEqual([
        'alarm_pipeline.alarms_received',
        'alarm_pipeline.signature_rejected',
        'alarm_pipeline.idempotent_dropped',
        'alarm_pipeline.severity_deferred',
        'alarm_pipeline.cooldown_attached',
        'alarm_pipeline.coalesced',
        'alarm_pipeline.investigations_launched',
      ]);
    });

    it('swallows a throwing `.info` sink without throwing', () => {
      const info = vi.fn(() => {
        throw new Error('logger exploded');
      });
      expect(() =>
        emitCounter({ info }, ALARM_PIPELINE_COUNTER_METRICS.COALESCED)
      ).not.toThrow();
    });

    it('swallows a throwing `.log` sink without throwing', () => {
      const log = vi.fn(() => {
        throw new Error('logger exploded');
      });
      expect(() =>
        emitCounter({ log }, ALARM_PIPELINE_COUNTER_METRICS.COALESCED)
      ).not.toThrow();
    });

    it('does nothing when no sink is provided', () => {
      expect(() => emitCounter(undefined, ALARM_PIPELINE_COUNTER_METRICS.COALESCED)).not.toThrow();
    });

    it('does nothing when the sink has neither `.info` nor `.log`', () => {
      expect(() => emitCounter({}, ALARM_PIPELINE_COUNTER_METRICS.COALESCED)).not.toThrow();
    });
  });

  describe('emitTiming', () => {
    it('rounds the millisecond value and includes the metric name', () => {
      const info = vi.fn();
      emitTiming(
        { info },
        ALARM_PIPELINE_LATENCY_METRIC,
        1234.6,
        { trigger_id: 'trigger-3' }
      );

      expect(info).toHaveBeenCalledWith(
        {
          metric: 'alarm_pipeline.trigger_to_investigation_ms',
          value_ms: 1235,
          trigger_id: 'trigger-3',
        },
        'alarm_pipeline.trigger_to_investigation_ms'
      );
    });

    it('drops negative durations instead of emitting a nonsensical latency', () => {
      const info = vi.fn();
      emitTiming({ info }, ALARM_PIPELINE_LATENCY_METRIC, -5);
      expect(info).not.toHaveBeenCalled();
    });

    it('drops non-finite durations', () => {
      const info = vi.fn();
      emitTiming({ info }, ALARM_PIPELINE_LATENCY_METRIC, Number.NaN);
      emitTiming({ info }, ALARM_PIPELINE_LATENCY_METRIC, Number.POSITIVE_INFINITY);
      expect(info).not.toHaveBeenCalled();
    });

    it('swallows sink errors without throwing', () => {
      const info = vi.fn(() => {
        throw new Error('logger exploded');
      });
      expect(() => emitTiming({ info }, ALARM_PIPELINE_LATENCY_METRIC, 100)).not.toThrow();
    });
  });
});
