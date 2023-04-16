import {Error} from "../models/error";

export class ErrorService {

    private createError(exception: any, serviceName: string): Error {
        const error = new Error();

        error.exception = exception;
        error.service = serviceName;

        return error;
    }

    public createRedmineError(exception: any): Error {
       return this.createError(exception, "Redmine");
    }

    public createTogglError(exception: any): Error {
        return this.createError(exception, "Toggl")
    }
}