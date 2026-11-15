/**
 * Running and recent verified saves (#4487). A job can run for hours, so the
 * list polls while any job is live and lets an admin cancel one.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { VERIFY_JOB_TERMINAL, type AdminVerifyJob } from '../../services/api';
import styles from './VerifyJobsPanel.module.css';

interface Props {
  nodeName: (nodeNum: number) => string;
  /** Bump to refetch now, e.g. after a save started a job. */
  refreshKey?: number;
}

function minutesUntil(ts: number | null): number | null {
  return ts == null ? null : Math.max(0, Math.ceil((ts - Date.now()) / 60_000));
}

export const VerifyJobsPanel: React.FC<Props> = ({ nodeName, refreshKey = 0 }) => {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<AdminVerifyJob[]>([]);

  const load = useCallback(async () => {
    try {
      setJobs(await apiService.getVerifyJobs());
    } catch {
      // Best effort: a failed poll keeps the last list.
    }
  }, []);

  const anyRunning = jobs.some((j) => !VERIFY_JOB_TERMINAL.has(j.status));
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), anyRunning ? 10_000 : 60_000);
    return () => clearInterval(timer);
  }, [load, anyRunning, refreshKey]);

  if (jobs.length === 0) return null;

  const cancel = async (job: AdminVerifyJob) => {
    await apiService.cancelVerifyJob(job.id);
    await load();
  };

  const detail = (job: AdminVerifyJob): string => {
    if (job.error) return job.error.message;
    if (job.status === 'waiting' && job.nextCheckAt != null) {
      const mins = minutesUntil(job.nextCheckAt);
      return t('admin_commands.verify_jobs.next_check', 'Next check in {{mins}} min', { mins });
    }
    if (job.differingFields.length) {
      return t('admin_commands.verify_jobs.differs_fields', 'Node stored other values for: {{fields}}', { fields: job.differingFields.join(', ') });
    }
    if (job.pendingFields.length) {
      return t('admin_commands.verify_jobs.pending_fields', 'Still old: {{fields}}', { fields: job.pendingFields.join(', ') });
    }
    if (job.lastCheckOutcome === 'no_reply') return t('admin_commands.verify_jobs.no_reply', 'Last check got no reply');
    return '';
  };

  return (
    <div className={styles.panel}>
      <h4 className={styles.heading}>{t('admin_commands.verify_jobs.title', 'Verified saves')}</h4>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t('admin_commands.verify_jobs.node', 'Node')}</th>
            <th>{t('admin_commands.verify_jobs.section', 'Section')}</th>
            <th>{t('admin_commands.verify_jobs.status', 'Status')}</th>
            <th>{t('admin_commands.verify_jobs.sends', 'Sends')}</th>
            <th>{t('admin_commands.verify_jobs.checks', 'Checks')}</th>
            <th>{t('admin_commands.verify_jobs.detail', 'Detail')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>{nodeName(job.destinationNodeNum)}</td>
              <td>{job.section}</td>
              <td className={styles[`status_${job.status}`] ?? ''}>
                {t(`admin_commands.verify_jobs.status_${job.status}`, job.status)}
              </td>
              <td>{job.sends}/{job.maxSends}</td>
              <td>{job.checks}</td>
              <td className={styles.detail}>{detail(job)}</td>
              <td>
                {!VERIFY_JOB_TERMINAL.has(job.status) && (
                  <button type="button" className="button button-secondary" onClick={() => void cancel(job)}>
                    {t('admin_commands.verify_jobs.cancel', 'Cancel')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
