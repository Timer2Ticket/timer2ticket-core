import { Scope } from "@sentry/node";
import * as Sentry from '@sentry/node';
import { TimeEntry } from "../models/synced_service/time_entry/time_entry";
import { ExtraContext } from "../models/extra_context";
import { Context } from "@sentry/types";
import { setMaxListeners } from "superagent";
export class SentryService {
    public logRedmineError(uri: string, error: any, extraContext?: ExtraContext | ExtraContext[] | null): void {
        const sentryScope = new Scope();
        sentryScope.setTag("Service", "Redmine");
        sentryScope.setContext("Service url", { url: uri });

        if (extraContext) {
            this.addExtraContext(sentryScope, extraContext);
        }

        Sentry.captureException(error, sentryScope);
    }

    public logTogglError(error: any, extraContext?: ExtraContext | ExtraContext[] | null): void {
        const sentryScope = new Scope();
        sentryScope.setTag("Service", "Toggl");

        if (extraContext) {
            this.addExtraContext(sentryScope, extraContext);
        }


        Sentry.captureException(error, sentryScope);
    }

    public logJiraError(uri: string, error: any, extraContext?: ExtraContext | ExtraContext[] | null): void {
        const sentryScope = new Scope()
        sentryScope.setTag("Service", "Redmine");
        sentryScope.setContext("Service url", { url: uri });

        if (extraContext) {
            this.addExtraContext(sentryScope, extraContext);
        }
        Sentry.captureException(error, sentryScope)
    }

    public logError(error: any, extraContext?: ExtraContext | ExtraContext[] | null): void {
        const sentryScope = new Scope();

        if (extraContext) {
            this.addExtraContext(sentryScope, extraContext);
        }

        Sentry.captureException(error, sentryScope);
    }

    public createExtraContext(name: string, context: Context): ExtraContext {
        const extraContext = new ExtraContext();
        extraContext.name = name;
        extraContext.context = context;
        return extraContext;
    }

    private addExtraContext(scope: Scope, extraContext: ExtraContext | ExtraContext[]): void {
        if (Array.isArray(extraContext)) {
            for (const context of extraContext) {
                scope.setContext(context.name, context.context);
            }
        } else {
            scope.setContext(extraContext.name, extraContext.context);
        }
    }
}