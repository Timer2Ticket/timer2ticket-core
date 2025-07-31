export class T2tErrorExtraContext {
    service!: string;
    functionName!: string;
    objectId: string | null = null;
    objectExtraInformation: string[] = [];
    responseErrors: string[] = [];

    constructor(service: string, functionName: string, objectId: string | null = null, objectExtraInformation: string[] = []) {
        this.service = service;
        this.functionName = functionName;
        this.objectId = objectId;
        this.objectExtraInformation = objectExtraInformation;
    }
}
