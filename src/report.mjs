/* 결과 정리·GitHub 에 남기기(커밋 상태 + PR 댓글). gh CLI 로그인 정보를 그대로 쓴다. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ICON = { success: '✅', failure: '❌', skipped: '⏭️' };

export function summarize(run) {
  const jobs = run.jobs;
  const failed = jobs.filter((j) => j.status === 'failure');
  const ran = jobs.filter((j) => j.status !== 'skipped');
  const partial = jobs.filter((j) => j.partial);
  const state = failed.length ? 'failure' : ran.length ? 'success' : 'skipped';
  return { state, failed: failed.length, ran: ran.length, partial: partial.length, skippedJobs: jobs.length - ran.length };
}

export function toMarkdown(run) {
  const s = summarize(run);
  const head = s.state === 'failure' ? '❌ 실패' : s.state === 'success' ? (s.partial ? '✅ 통과(일부 단계 건너뜀)' : '✅ 통과') : '⏭️ 돌릴 작업 없음';
  const lines = [
    `### local-ci ${head}`,
    '',
    `- 저장소: \`${run.repo}\` · 커밋: \`${run.sha.slice(0, 10)}\` · 이벤트: \`${run.event}\`${run.base ? ` · 기준: \`${run.base}\`` : ''}`,
    `- 실행 환경: ${run.host.platform} · node ${run.host.node}${run.host.bash ? ` · bash ${run.host.bash}` : ''} · 줄바꿈 ${run.host.eol ?? '-'} · ${run.startedAt} · ${(run.ms / 1000).toFixed(0)}초`,
    `- 캐시: ${run.host.cache === '꺼짐' || !run.host.cache ? '꺼짐' : '켜짐(이 PC 캐시 폴더)'} · 대체 규칙: ${run.rules ?? 0}개`,
    '- GitHub Actions 대신 로컬 깨끗한 작업 사본에서 같은 단계를 돌린 결과입니다. 비밀 키가 필요한 단계는 돌리지 않습니다.',
    ...(run.notes ?? []).map((n) => `- ⚠️ ${n}`),
    '',
  ];
  for (const wf of run.workflows) {
    if (!wf.run) { lines.push(`- ⏭️ **${wf.name}** (\`${wf.file}\`) — ${wf.reason}`); continue; }
    for (const j of run.jobs.filter((x) => x.file === wf.file)) {
      lines.push(`- ${ICON[j.status]} **${wf.name} / ${j.name}**${j.reason ? ` — ${j.reason}` : ''}`);
      for (const st of j.steps) {
        const extra = [st.note, st.exitCode !== undefined && st.exitCode !== 0 ? `종료 코드 ${st.exitCode}` : null, st.ms ? `${(st.ms / 1000).toFixed(1)}초` : null].filter(Boolean).join(' · ');
        lines.push(`  - ${ICON[st.status]} ${st.index}. ${st.name}${extra ? ` (${extra})` : ''}`);
      }
      for (const c of j.cache ?? []) if (c.saved) lines.push(`  - 💾 캐시 저장: \`${c.key}\` (경로 ${c.saved}개)`);
      for (const w of j.warnings) lines.push(`  - ⚠️ ${w}`);
    }
  }
  return lines.join('\n');
}

function gh(args, input) {
  return String(execFileSync('gh', args, { input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })).trim();
}

/** origin 주소에서 owner/repo. */
export function repoSlug(repoDir) {
  const url = String(execFileSync('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/.exec(url);
  if (!m) throw new Error(`GitHub origin 이 아닙니다: ${url}`);
  return `${m[1]}/${m[2]}`;
}

/** 커밋 상태(local-ci/<워크플로>) 와 PR 댓글을 남긴다. */
export function postToGitHub(run, { slug, pr, context = 'local-ci', mdFile }) {
  const posted = [];
  for (const wf of run.workflows.filter((w) => w.run)) {
    const jobs = run.jobs.filter((j) => j.file === wf.file);
    const fail = jobs.some((j) => j.status === 'failure');
    const partial = jobs.some((j) => j.partial);
    const desc = `${fail ? '실패' : '통과'}${partial ? '(비밀 키·미지원·대체 규칙 건너뜀)' : ''} · ${run.host.platform} 로컬`.slice(0, 140);
    gh(['api', '--method', 'POST', `repos/${slug}/statuses/${run.sha}`, '-f', `state=${fail ? 'failure' : 'success'}`, '-f', `context=${context}/${wf.name}`, '-f', `description=${desc}`]);
    posted.push(`${context}/${wf.name}`);
  }
  if (pr) {
    writeFileSync(mdFile, toMarkdown(run));
    gh(['pr', 'comment', String(pr), '--repo', slug, '--body-file', mdFile]);
    posted.push(`PR #${pr} 댓글`);
  }
  return posted;
}
