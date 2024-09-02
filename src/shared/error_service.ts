import { Timer2TicketError } from "../models/timer2TicketError";

export class ErrorService {
    static readonly redmineServiceName = "Redmine";
    static readonly togglServiceName = "Toggl";
    static readonly jiraServiceName = "Jira";
    static readonly configJobSpecificationName = "Config Job"

    public createError(exception: any, specification: string): Timer2TicketError {
        const error = new Timer2TicketError();

        error.exception = exception;
        error.specification = specification;

        return error;
    }

    public createConfigJobError(exception: any): Timer2TicketError {
        return this.createError(exception, ErrorService.configJobSpecificationName)
    }

    public createRedmineError(exception: any): Timer2TicketError {
        return this.createError(exception, ErrorService.redmineServiceName);
    }

    public createTogglError(exception: any): Timer2TicketError {
        return this.createError(exception, ErrorService.togglServiceName)
    }

    public createJiraError(exception: any): Timer2TicketError {
        return this.createError(exception, ErrorService.jiraServiceName)
    }
}