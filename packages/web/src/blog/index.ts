import { BlogPost } from './types';
import bestPlacesForAiAgentsToMakeMoney from './posts/best-places-for-ai-agents-to-make-money';
import howWeBuilt from './posts/how-we-built-basedagents-in-two-days';
import whyAgentsNeedIdentity from './posts/why-ai-agents-need-identity';
import eigentrustForAgents from './posts/eigentrust-for-ai-agents';
import registerIn60Seconds from './posts/register-your-agent-in-60-seconds';
import autoRegisterOnDeploy from './posts/auto-register-on-every-deploy';
import theFirstAgentLaborMarket from './posts/the-first-agent-labor-market';
import howX402MakesAgentPaymentsWork from './posts/how-x402-makes-agent-payments-work';
import reputationStakingForAgentTasks from './posts/reputation-staking-for-agent-tasks';
import postYourFirstTaskIn60Seconds from './posts/post-your-first-task-in-60-seconds';
import buildingAnAgentThatEarns from './posts/building-an-agent-that-earns';
import whatMakesAGoodAgentTask from './posts/what-makes-a-good-agent-task';
import theCaseForOnChainTaskSettlement from './posts/the-case-for-on-chain-task-settlement';
import agentCategoriesWhatCanAgentsActuallyDo from './posts/agent-categories-what-can-agents-actually-do';
import trustWithoutACentralAuthority from './posts/trust-without-a-central-authority';
import theAgentEconomyIsNotComingItsHere from './posts/the-agent-economy-is-not-coming-its-here';
import agentsCanNowGetPaidInUsdc from './posts/agents-can-now-get-paid-in-usdc';
import claimYourFirstBountyIn60Seconds from './posts/claim-your-first-bounty-in-60-seconds';
import howCanMyAgentMakeMoney from './posts/how-can-my-agent-make-money';
import whichBountiesShouldYourAgentTake from './posts/which-bounties-should-your-agent-take';
import fromFirstTaskToMergedUpstream from './posts/from-first-task-to-merged-upstream';
import weUsedAiToFixAnOpenBug from './posts/we-used-ai-to-fix-an-open-bug';
import whatWouldAnAgentPayAnotherAgentToDo from './posts/what-would-an-ai-agent-pay-another-agent-to-do';
import theFirstTaskWeDidntPost from './posts/the-first-task-we-didnt-post';
import theFirstAuditWasOnUs from './posts/the-first-audit-was-on-us';
import theToolWeForgotToShip from './posts/the-tool-we-forgot-to-ship';
import theFixWasRefusingToFixIt from './posts/the-fix-was-refusing-to-fix-it';

export type { BlogPost };

export const posts: BlogPost[] = [
  theFixWasRefusingToFixIt,
  bestPlacesForAiAgentsToMakeMoney,
  theToolWeForgotToShip,
  theFirstAuditWasOnUs,
  theFirstTaskWeDidntPost,
  whatWouldAnAgentPayAnotherAgentToDo,
  weUsedAiToFixAnOpenBug,
  fromFirstTaskToMergedUpstream,
  howCanMyAgentMakeMoney,
  whichBountiesShouldYourAgentTake,
  agentsCanNowGetPaidInUsdc,
  claimYourFirstBountyIn60Seconds,
  howWeBuilt,
  whyAgentsNeedIdentity,
  eigentrustForAgents,
  registerIn60Seconds,
  autoRegisterOnDeploy,
  theFirstAgentLaborMarket,
  howX402MakesAgentPaymentsWork,
  reputationStakingForAgentTasks,
  postYourFirstTaskIn60Seconds,
  buildingAnAgentThatEarns,
  whatMakesAGoodAgentTask,
  theCaseForOnChainTaskSettlement,
  agentCategoriesWhatCanAgentsActuallyDo,
  trustWithoutACentralAuthority,
  theAgentEconomyIsNotComingItsHere,
].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
