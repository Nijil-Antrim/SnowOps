// 1. CONFIGURATION
// Note: No API Key needed!
const routeLayerUrl = "https://services9.arcgis.com/t2uVlIEulJrk7ioC/arcgis/rest/services/Snow_Plowing_Routes_2026_WFL1/FeatureServer/0"; 
const breadcrumbLayerUrl = "https://services9.arcgis.com/t2uVlIEulJrk7ioC/arcgis/rest/services/Snowplow_Breadcrumbs/FeatureServer/0"; 

// Initialize Map
const map = L.map('map', {
    zoomControl: false // We will add zoom control manually to position it
}).setView([39.7732, -77.7242], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
}).addTo(map);

// 2. Add Controls in specific order (Top Left)
// Zoom Control
L.control.zoom({ position: 'topleft' }).addTo(map);

// --- Custom "Home" Button (Reset Filter) ---
const HomeControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function(map) {
        const btn = L.DomUtil.create('div', 'custom-map-btn');
        btn.innerHTML = "🏠"; // Home Icon
        btn.title = "Reset Filter / Logout";
        btn.onclick = function() {
            // Reset everything
            routeLayer.setWhere("1=1"); // Show all (or hide all if preferred)
            document.getElementById('panel').style.display = 'block'; // Show login
            document.getElementById('activeOperatorLabel').style.display = 'none'; // Hide label
            map.setView([39.7732, -77.7242], 13); // Reset Zoom
        };
        return btn;
    }
});
map.addControl(new HomeControl());

// --- Custom "Locate Me" Button ---
const LocateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function(map) {
        const btn = L.DomUtil.create('div', 'custom-map-btn');
        btn.innerHTML = "🎯"; // Target Icon
        btn.title = "Find My Location";
        btn.onclick = function() {
            if(lastKnownLocation) {
                map.setView(lastKnownLocation, 17);
            } else {
                alert("GPS location not yet found. Drive a bit!");
            }
        };
        return btn;
    }
});
map.addControl(new LocateControl());

// --- Custom "Legend" Button ---
const LegendControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function(map) {
        const btn = L.DomUtil.create('div', 'custom-map-btn');
        btn.innerHTML = "📝"; // Legend Icon
        btn.title = "Show Legend";
        btn.onclick = function() {
            alert("LEGEND:\n\n🔴 Red Lines: Plowing Routes\n🔵 Blue Dot: Your Live Location");
        };
        return btn;
    }
});
map.addControl(new LegendControl());

// --- Scale Bar (Bottom Left) ---
L.control.scale({ position: 'bottomleft', imperial: true, metric: false }).addTo(map);


// 3. Data Layers
let currentOperator = "";
let currentTruck = "";
let watchId = null;
let lastKnownLocation = null;

const routeLayer = L.esri.featureLayer({
  url: routeLayerUrl,
  style: { color: 'red', weight: 4 }, // Antrim Red style
  onEachFeature: function(feature, layer) {
    layer.on('click', function(e) {
      const lat = e.latlng.lat;
      const lng = e.latlng.lng;
      const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
      
      let popupContent = "<b>Route Attributes:</b><br><hr style='margin: 5px 0;'>";
      for (const key in feature.properties) {
          const value = feature.properties[key];
          if(value !== null && key !== "GlobalID" && key !== "Shape__Length") {
             popupContent += `<b>${key}:</b> ${value}<br>`;
          }
      }
      popupContent += `<br><a href="${googleMapsUrl}" target="_blank" style="background:green; color:white; padding:5px; display:block; text-align:center; text-decoration:none;">Navigate Here</a>`;
      layer.bindPopup(popupContent).openPopup();
    });
  }
});

// Auto-populate Dropdowns
routeLayer.query().where("1=1").run(function(error, featureCollection){
    if (error) return;
    let operators = new Set();
    let trucks = new Set();

    featureCollection.features.forEach(function(f){
        if(f.properties.Operator) operators.add(f.properties.Operator);
        if(f.properties.Truck_Num) trucks.add(f.properties.Truck_Num);
    });

    const opSelect = document.getElementById("operatorInput");
    opSelect.innerHTML = '<option value="">-- Select Your Name --</option>';
    Array.from(operators).sort().forEach(name => {
        let opt = document.createElement("option");
        opt.value = name; opt.innerText = name; opSelect.appendChild(opt);
    });

    const truckSelect = document.getElementById("truckInput");
    truckSelect.innerHTML = '<option value="">-- Select Truck --</option>';
    Array.from(trucks).sort((a, b) => a - b).forEach(num => {
        let opt = document.createElement("option");
        opt.value = num; opt.innerText = "Truck " + num; truckSelect.appendChild(opt);
    });
});

// 4. Main Logic
function startShift() {
  currentOperator = document.getElementById('operatorInput').value;
  currentTruck = document.getElementById('truckInput').value;

  if(!currentOperator && !currentTruck) {
    alert("Please select an Operator Name OR a Truck Number.");
    return;
  }

  // Hide Login, Show Map Info
  document.getElementById('panel').style.display = 'none';
  
  // UPDATE THE NEW LABEL
  const label = document.getElementById('activeOperatorLabel');
  label.style.display = 'block';
  if(currentOperator) {
      label.innerText = "Viewing Route for: " + currentOperator;
  } else {
      label.innerText = "Viewing Route for Truck: " + currentTruck;
  }

  // Filter Layer
  let sqlParts = [];
  if (currentOperator) sqlParts.push(`Operator = '${currentOperator}'`);
  if (currentTruck) sqlParts.push(`Truck_Num = ${currentTruck}`);
  const finalWhere = sqlParts.join(" OR ");
  
  routeLayer.setWhere(finalWhere);
  routeLayer.addTo(map);

  routeLayer.query().where(finalWhere).bounds(function(error, latLngBounds){
    if(!error && latLngBounds) map.fitBounds(latLngBounds);
  });

  startTracking();
}

function startTracking() {
  if (!navigator.geolocation) { alert("Geolocation not supported"); return; }
  watchId = navigator.geolocation.watchPosition(success, error, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 10000
  });
}

function success(position) {
  const lat = position.coords.latitude;
  const lng = position.coords.longitude;
  lastKnownLocation = [lat, lng];

  if (!window.myLocationMarker) {
    window.myLocationMarker = L.circleMarker([lat, lng], { color: 'blue', radius: 8 }).addTo(map);
  } else {
    window.myLocationMarker.setLatLng([lat, lng]);
  }

  // Send Breadcrumb
  const feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: {
      Truck_Num: parseInt(currentTruck) || 0,
      Operator: currentOperator,
      Type_Truck: "Not Specified",
      Timestamp: new Date().getTime()
    }
  };

  L.esri.request(breadcrumbLayerUrl + "/addFeatures", { features: [feature] }, function(error, response){});
}
function error() { console.log("GPS Error"); }