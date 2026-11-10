import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { clientFeaturesHeader, nullableTitleFeature } from '@reviewr/shared';
import { map, Observable } from 'rxjs';

/** What the interceptor reads from the request (Fastify lower-cases header names). */
interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/** What the interceptor uses of the response (a Fastify reply). */
interface ReplyWithHeaders {
  getHeader(name: string): unknown;
  header(name: string, value: string): unknown;
}

/**
 * Add the features header to `Vary`, keeping what is already there: the answer depends on it, so a shared cache
 * must not serve the answer made for a current app to an older one, or the reverse.
 */
const varyOnFeatures = (reply: ReplyWithHeaders): void => {
  const current: unknown = reply.getHeader('Vary');
  const joined: string = Array.isArray(current) ? current.join(',') : typeof current === 'string' ? current : '';
  const values: string[] = joined
    .split(',')
    .map((value: string) => value.trim())
    .filter((value: string) => value.length > 0);

  if (!values.some((value: string) => value.toLowerCase() === clientFeaturesHeader.toLowerCase())) {
    reply.header('Vary', [...values, clientFeaturesHeader].join(', '));
  }
};

/**
 * Whether the request announces that the client understands `title: null`.
 */
const understandsNullableTitle = (request: RequestWithHeaders): boolean => {
  const header: string | string[] | undefined = request.headers[clientFeaturesHeader.toLowerCase()];
  const values: string[] = Array.isArray(header) ? header : [header ?? ''];

  return values.some((value: string) =>
    value
      .split(',')
      .map((feature: string) => feature.trim())
      .includes(nullableTitleFeature),
  );
};

/**
 * `title: null` → `title: ''` in a document, a revision or their summaries (or a list of them).
 */
const withEmptyTitle = (body: unknown): unknown => {
  if (Array.isArray(body)) {
    return body.map(withEmptyTitle);
  }
  // eslint-disable-next-line no-null/no-null -- null is how the API sends an untitled document
  if (typeof body === 'object' && body !== null && 'title' in body && body.title === null) {
    return { ...body, title: '' };
  }

  return body;
};

/**
 * Keeps the response format of apps built before titles could be absent: they call `title.trim()` on every
 * document, so an untitled one is answered with `title: ''` unless the request announces the
 * `nullable-title` feature (see `withClientFeatures` in `@reviewr/shared`). Storage is not affected: an
 * untitled document is NULL in the database, and the API accepts `''` as "no title".
 */
@Injectable()
export class LegacyTitleInterceptor implements NestInterceptor {
  /**
   * Rewrite the response for clients that do not announce the feature.
   */
  // eslint-disable-next-line class-methods-use-this -- required by the NestInterceptor interface
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request: RequestWithHeaders = context.switchToHttp().getRequest<RequestWithHeaders>();
    varyOnFeatures(context.switchToHttp().getResponse<ReplyWithHeaders>());
    if (understandsNullableTitle(request)) {
      return next.handle();
    }

    return next.handle().pipe(map(withEmptyTitle));
  }
}
