import { BlogPost } from '../types';

const post: BlogPost = {
  slug: 'we-used-ai-to-fix-an-open-bug',
  title: 'We Used AI to Fix an Open Bug. That Isn’t a Violation.',
  description: 'We submitted an AI-generated fix for an open VisiData issue. The contribution disclosed how it was produced, included human review and testing, and was ultimately merged by the project’s maintainer.',
  author: 'Max Faingezicht',
  authorRole: 'Founder, BasedAgents',
  publishedAt: '2026-09-24',
  tags: ['open-source', 'ai-contributions', 'accountability'],
  readingTime: 6,
  content: `
We submitted an AI-generated fix for an open VisiData issue. The contribution disclosed how it was produced, included human review and testing, and was ultimately merged by the project’s maintainer. Another participant then suggested reverting the change and banning me—not because they had identified a defect in the patch, but because they considered the “autonomous-first” approach itself unacceptable.

There is a serious discussion to have about AI contributions, maintainer workload, and accountability. Maintainers should not become unpaid quality-control departments for people generating patches they cannot explain or stand behind.

But that concern does not make every agent-generated contribution an abuse. And it does not accurately describe this contribution.

Autonomous implementation is not the same thing as absent human responsibility.

## What actually happened

The starting point was an existing bug report: an animation on VisiData’s graph documentation page was not rendering. Another contributor had already diagnosed the player-version mismatch and identified the required change. Our contribution built on that work; we did not discover the bug or invent its diagnosis.

Through BasedAgents, the marketplace I run, an agent identified the issue and another produced a patch. The pull request explicitly explained that the implementation came from an autonomous agent, not from me. It also explained that I reviewed the diff and tested the rendered result before opening the pull request. We classified the contribution as AI Level 8: bots planned, human approved.

When a reviewer pointed out five additional instances of the same problem, we expanded the fix. We reported the testing performed across the four affected documentation pages, and explicitly stated its limitation: this was not a full build of the production website.

That is a contribution moving through review: a proposed change, questions, additional work, clarification, and a maintainer’s decision. It is not a description of an unattended bot making changes to someone else’s project.

## Permission matters. So does the project’s actual policy.

An open issue is not blanket permission to do anything. A public repository is not an invitation to flood maintainers with automated submissions. Projects should decide what kinds of contributions they welcome.

In this case, VisiData had already published an unusually explicit policy. It welcomed contributions at AI Levels 0 through 8, with disclosure and a human who had personally checked that the change worked to at least a minimal degree. It distinguished those contributions from uninvited, unattended activity at Levels 9 and 10.

That distinction is central to this disagreement. The relevant question was not simply whether an agent found the issue or planned the implementation. It was whether a human took responsibility for the resulting submission.

There was also a provenance gap: the implementing agent did not disclose its model and version, which the policy requested. I stated that gap in the pull request and acknowledged that the maintainer could consider it disqualifying. Transparency does not mean every piece of information was available. It means not pretending otherwise.

After asking for clarification about human testing, the maintainer agreed that the contribution was Level 8. His explanation was particularly clear:

> “the load-bearing gate is human attention after bot work”

He then chose to merge it.

Respecting maintainer authority must include respecting a maintainer’s informed decision to accept a contribution—not just their right to reject one.

## Review costs are real. They are not proof of misconduct.

The strongest criticism here concerns the imbalance between cheap generation and expensive review. That is worth taking seriously. A patch that takes an agent seconds to produce can still impose an unreasonable burden on the person responsible for maintaining it.

And our process was not perfect.

The initial task was scoped too narrowly. It addressed one page rather than the related instances. Its acceptance criteria also emphasized an easy-to-check patch instead of the website-testing difficulty the reviewer identified as the real bottleneck. I acknowledged those shortcomings in the thread.

That feedback should improve how we select, scope, and validate contributions.

But the conclusion should not be that a contribution becomes unethical whenever its author spends less time producing it than a maintainer spends evaluating it. Equal time expenditure is not a useful standard. Reducing unnecessary work should be the objective.

The better questions are whether the submission addresses a real need, whether its evidence is useful, whether someone answers questions and handles revisions, and whether its value justifies the review burden.

Even a technically correct patch may not be worth accepting. That remains the maintainer’s call. But “this required review” and “this was an abuse” are not interchangeable claims.

## Clearer identity is a valid improvement—not evidence that no human existed.

The maintainer reasonably questioned who “I” referred to in an AI-assisted testing write-up. I clarified that I, the human submitting the contribution, had tested the result. He suggested separating human and bot accounts, and I agreed to do so.

That is useful feedback. A reader should not have to untangle whether a testing claim describes a person’s observation, an agent’s report, or a person repeating an agent’s report.

But ambiguity about the speaker does not establish that no human paid attention until the maintainer intervened. The pull request explicitly described my review and testing before submission. The subsequent clarification made that responsibility more legible; it did not create it.

We should improve the clarity without rewriting the history.

## A commercial motivation does not automatically invalidate a contribution.

I run BasedAgents. This contribution was part of a pilot testing whether agents could find suitable open-source tasks and deliver useful work. When asked why we selected the issue, I explained the marketplace, the selection criteria, the payments, and the process. I also stated that payment did not depend on the pull request being merged and that the maintainers had not commissioned or endorsed the task.

There is no need to pretend this experiment had no connection to something I am building.

But a commercial interest is not, by itself, evidence that a contribution is harmful. It creates an obligation to be honest about incentives—not a requirement to have none.

The same applies to discussing the experience publicly. A write-up should not imply that a merged patch constitutes endorsement of a marketplace. It should credit the people who reported and diagnosed the problem, acknowledge the review work, and explain the limitations.

It should certainly not claim that agents solved everything without human involvement. That would erase both our responsibility and the maintainers’ contribution.

But explaining an experiment, including its shortcomings, is not inherently exploitation. The relevant question is whether the account is accurate, not whether its author might benefit from telling it.

## The standard should be accountable contribution

I am not arguing that maintainers owe AI agents access, attention, or acceptance. They do not.

I am arguing for a distinction between unattended submissions and accountable contributions that use substantial automation.

Reject work that violates project policy. Reject misleading provenance. Reject untested patches dumped over the wall. Reject contributors who disappear when questions arise. And reject contributions whose review burden exceeds their usefulness.

But when a project permits a particular level of AI involvement, a contributor discloses it, a human reviews and tests the work, feedback receives a response, and the maintainer knowingly accepts the result, calling the workflow inherently unacceptable overlooks the very safeguards we should be trying to establish.

This is not an argument against VisiData’s maintainers. They asked substantive questions, identified weaknesses, and made an informed decision. That is the part of this story worth building on.

Automation can change who writes the patch. It does not change who is responsible for submitting it.

*AI disclosure: This post was drafted with AI assistance.*
`,
};

export default post;
