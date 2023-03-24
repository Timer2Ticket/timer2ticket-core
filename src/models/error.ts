

export class Error {
    service: string;
    exception: unknown;
    data: unknown;


    constructor() {
        this.service = "";
        this.exception = {};
        this.data = {};
    }
}