# timer2ticket-core

## Prerequisites

* Node
* Recommended IDE is JetBrains PhpStorm or WebStorm

## Setup

1. Install dependencies
    ```bash
    npm install 
    ```
2. Install nodemon tool
   ```bash
   npm install -g nodemon
   ```
3. Start MongoDB container
   ```bash
   docker-compose up -d
   ```
4. Run App
   ```bash
   npm start
   ```
5. Use prepared Postman collection to call API.


## Debugging

1. Allow source map generation in `tsconfig.json` file.
2. Run app in debug mode
   ```bash
   npm run start:debug
   ```
3. Create debug configuration in JetBrains PhpStorm/WebStorm.
   * Configuration type: **Attach to Node.js/Chrome**
   * Host: **localhost**
   * Port: **9229**
4. Set breakpoints and start debugging from IDE.

## Database
You can seed database with prepared data if you want.

1. Obtain your Redmine API Key and copy it to `apiKey` attribute in `serviceDefinitions` array in `seed.js` file.
2. Copy seed script into mongo container.
   ```bash
   docker cp seed.js timer2ticket-core-mongo-1:/seed.js
   ```
3. Run seed script in container.
   ```bash
   docker exec -it timer2ticket-core-mongo-1 mongosh --file seed.js
   ```