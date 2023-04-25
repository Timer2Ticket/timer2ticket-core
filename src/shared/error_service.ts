import {Timer2ticketError} from "../models/timer2ticketError";

export class ErrorService {
    static readonly redmineServiceName = "Redmine";
    static readonly togglServiceName = "Toggl";
    static readonly configJobSpecificationName = "Config Job"

    public createError(exception: any, specification: string): Timer2ticketError {
        const error = new Timer2ticketError();

        error.exception = exception;
        error.specification = specification;

        return error;
    }

    public createConfigJobError(exception: any): Timer2ticketError {
        return this.createError(exception, ErrorService.configJobSpecificationName)
    }

    public createRedmineError(exception: any): Timer2ticketError {
       return this.createError(exception, ErrorService.redmineServiceName);
    }

    public createTogglError(exception: any): Timer2ticketError {
        return this.createError(exception, ErrorService.togglServiceName)
    }
}