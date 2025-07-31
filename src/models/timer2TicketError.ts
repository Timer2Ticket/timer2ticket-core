import {T2tErrorExtraContext} from "./t2t_error_extra_context";


export class Timer2TicketError {
    specification: string;
    exception: unknown;
    data: T2tErrorExtraContext | undefined;


    constructor() {
        this.specification = "";
        this.exception = {};
        this.data = undefined;
    }
}