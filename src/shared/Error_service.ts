import {Error} from "../models/error";

export class ErrorService {
    public createRedmineError(exception: any): Error {
       const error = new Error();

       error.service = "Redmine";
       error.exception = exception;

       return error;
    }

    public createTogglError(exception: any): Error {
        const error = new Error();

        error.service = "Toggl";
        error.exception = exception;

        return error;
    }
}