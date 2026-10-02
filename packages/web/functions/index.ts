// `/` on the web host: content negotiation for agents (packages/api/src/discovery/pages-front-door.ts).
import { frontDoor, type PagesContext } from '../../api/src/discovery/pages-front-door';
import { ROOT_HEADERS } from './headers.generated';

export const onRequest = (ctx: PagesContext): Promise<Response> => frontDoor(ctx, ROOT_HEADERS);
