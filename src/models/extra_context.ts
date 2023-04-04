import {Context} from "@sentry/types";
export class ExtraContext {
     name: string
    context: Context




    constructor() {
        this.name = ""
        this.context = {}
    }
}