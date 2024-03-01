const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const https = require('https');
class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/fetchDoors', this.fetchDoors.bind(this));
    this.ready();
  }


  async fetchDoors(payload) {
    try {
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });
      const myHeaders = new Headers();
      myHeaders.append("Authorization", `Bearer ${payload.apiToken}`);

      const requestOptions = {
        method: 'GET',
        headers: myHeaders,
        redirect: 'follow',
        agent: httpsAgent,
      };
      const response = await fetch(`https://${payload.consoleHost}:12445/api/v1/developer/doors`, requestOptions)

      const data = await response.json();

      if(data.code !== "SUCCESS" || !data.data){
        if(data.msg){
          throw new Error(data.msg);
        }else{
          throw new Error("Whoops!");
        }
      }

      if(data.data.length === 0){
        throw new Error("No doors found");
      }

      // return data to the ui
      return {
        doorId: data.data[0].id,
        doorName: data.data[0].name,
        doors: data.data
      }
    } catch (e) {
      console.log(e);
      throw new RequestError('Error while retrieving unifi infos', { message: e.message });
    }
  }
}

(() => {
  return new PluginUiServer();
})();
