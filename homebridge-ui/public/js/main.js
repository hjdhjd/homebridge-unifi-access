(async () => {
    // get the initial config - this is an array potentially containing multiple config blocks
    const pluginConfig = await homebridge.getPluginConfig();

    // get the intial from the config and add it to the form
    if (pluginConfig.length) {
        document.querySelector('#apiTokenInput').value = pluginConfig[0].apiToken;
        document.querySelector('#doorIdInput').value = pluginConfig[0].doorId;
        document.querySelector('#doorNameInput').value = pluginConfig[0].doorName;
        document.querySelector('#consoleHostInput').value = pluginConfig[0].consoleHost;
        document.querySelector('#consolePortInput').value = pluginConfig[0].consolePort;
        await fetchDoors();
    } else {
        pluginConfig.push({});
    }

    // watch for changes to the form and update the config
    document.getElementById('configForm').addEventListener('input', () => {
        // get the current values from the form
        pluginConfig[0].apiToken = document.querySelector('#apiTokenInput').value;
        pluginConfig[0].consoleHost = document.querySelector('#consoleHostInput').value;
        pluginConfig[0].consolePort = document.querySelector('#consolePortInput').value;
        pluginConfig[0].doorId = document.querySelector('#doorIdInput').value;
        pluginConfig[0].doorName = document.querySelector('#doorNameInput').value;

        // update the config
        homebridge.updatePluginConfig(pluginConfig);
    });

    async function fetchDoors(){
        // validate a api token was provided
        const apiToken = document.querySelector('#apiTokenInput').value;

        if (!apiToken) {
            // create a error / red toast notification if the required input is not provided.
            homebridge.toast.error('A unifi access API-Token must be provided.', 'Error');
            return;
        }

        const consoleHost = document.querySelector('#consoleHostInput').value;

        if (!consoleHost) {
            // create a error / red toast notification if the required input is not provided.
            homebridge.toast.error('A unifi access host must be provided.', 'Error');
            return;
        }

        const consolePort = document.querySelector('#consolePortInput').value;

        if (!consolePort) {
            // create a error / red toast notification if the required input is not provided.
            homebridge.toast.error('A unifi access port must be provided.', 'Error');
            return;
        }

        // starting the request, show the loading spinner
        homebridge.showSpinner();

        // request a token from the server
        try {
            const response = await homebridge.request('/fetchDoors', {
                apiToken: apiToken,
                consoleHost: consoleHost,
                consolePort: consolePort,
            });

            // update the token input with the response
            document.querySelector('#doorIdInput').value = response.doorId;
            document.querySelector('#doorNameInput').value = response.doorName;

            // update the plugin config
            pluginConfig[0].doorId = response.doorId;
            pluginConfig[0].doorName = response.doorName;
            console.log(response.doors)
            if(response.doors.length > 0){
                for(const door of response.doors){
                    $('#doorSelect').append(`<option value="${door.id}" ${(pluginConfig[0].doorId === door.id)?'selected':''}>${door.name}</option>`);
                }
            }
            homebridge.updatePluginConfig(pluginConfig);

            // show a success toast notification
            homebridge.toast.success(`Got ${response.doors.length} doors!`, 'Success');
        } catch (e) {
            console.log(e);
            homebridge.toast.error(e.error.message, e.message);
        } finally {
            // remember to un-hide the spinner
            homebridge.hideSpinner();
        }
    }

    // watch for click events on the getTokenButton
    document.querySelector('#getTokenButton').addEventListener('click', async () => {
        fetchDoors();
    });

})();
