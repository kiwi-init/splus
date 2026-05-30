/**
 * Splus GitHub App (Probot). Reviews PRs automatically or on @splus mention,
 * configured per-repo via .splus.yml (which the web dashboard writes).
 *
 * Event flow:
 *   pull_request.opened / reopened / ready_for_review → full review
 *   pull_request.synchronize                          → review new commits
 *   issue_comment.created (with @splus on a PR)       → on-demand review
 */
import type { Probot } from "probot";
import { getConfig } from "./config.js";
import { repoStore, reviewPR } from "./review.js";

export default (app: Probot): void => {
  app.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.ready_for_review",
      "pull_request.synchronize",
    ],
    async (ctx) => {
      const cfg = await getConfig(ctx);
      if (!cfg.auto_review || cfg.mention_only) return;
      const pr = ctx.payload.pull_request;
      if (pr.draft) return; // don't review drafts automatically
      await safe(ctx, () =>
        reviewPR(ctx, { number: pr.number, base: pr.base, head: pr.head }, cfg),
      );
    },
  );

  app.on("issue_comment.created", async (ctx) => {
    const { comment, issue } = ctx.payload;
    if (!issue.pull_request) return; // not a PR
    if (!/@splus\b/i.test(comment.body)) return; // not addressed to us

    // Learning command: `@splus mute <ruleId>` (or `dismiss`) teaches the repo.
    const muteCmd = comment.body.match(/@splus\s+(?:mute|dismiss)\s+([\w.\-]+)/i);
    if (muteCmd) {
      const ruleId = muteCmd[1]!;
      const { owner, repo } = ctx.repo();
      await repoStore(owner, repo).record({
        fingerprint: "",
        rule_id: ruleId,
        text: ruleId,
        scope: "rule",
        signal: "muted",
      });
      await ctx.octokit.issues.createComment(
        ctx.repo({ issue_number: issue.number, body: `🔇 Muted \`${ruleId}\` for this repo. Splus will stop flagging it.` }),
      );
      return;
    }

    const cfg = await getConfig(ctx);
    const { data: pr } = await ctx.octokit.pulls.get(
      ctx.repo({ pull_number: issue.number }),
    );
    await safe(ctx, () =>
      reviewPR(
        ctx,
        { number: pr.number, base: pr.base, head: pr.head },
        cfg,
      ),
    );
  });

  app.onError(async (err) => {
    app.log.error(err);
  });
};

/** Run a review, surfacing failures as a check rather than a silent drop. */
async function safe(ctx: any, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ctx.log?.error?.(err);
    try {
      await ctx.octokit.checks.create(
        ctx.repo({
          name: "Splus",
          head_sha: ctx.payload.pull_request?.head?.sha,
          status: "completed",
          conclusion: "neutral",
          output: {
            title: "Splus could not complete the review",
            summary: `An error occurred while reviewing this PR:\n\n\`\`\`\n${String(err)}\n\`\`\``,
          },
        }),
      );
    } catch {
      /* best-effort */
    }
  }
}
