// 1. CONFIGURATION
// Note: No API Key needed!
const routeLayerUrl = "https://services9.arcgis.com/t2uVlIEulJrk7ioC/arcgis/rest/services/Snow_Plowing_Routes_2026_WFL1/FeatureServer/0"; 
const breadcrumbLayerUrl = "https://services9.arcgis.com/t2uVlIEulJrk7ioC/arcgis/rest/services/Snowplow_Breadcrumbs/FeatureServer/0"; 

// Initialize Map
const map = L.map('map', { zoomControl: false }).setView([39.7732, -77.7242], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
}).addTo(map);

// Add Standard Controls
L.control.zoom({ position: 'topleft' }).addTo(map);
L.control.scale({ position: 'bottomleft', imperial: true, metric: false }).addTo(map);

// --- GLOBAL VARIABLES ---
let allRouteData = []; 
let currentOperator = "";
let currentTruck = "";
let watchId = null;
let lastKnownLocation = null;

// --- LAYERS ---
const routeLayer = L.esri.featureLayer({
  url: routeLayerUrl,
  style: { color: 'red', weight: 4 }, // Routes are RED
  onEachFeature: function(feature, layer) {
    layer.on('click', function(e) {
      const lat = e.latlng.lat;
      const lng = e.latlng.lng;
      const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
      
      let popupContent = "<b>Route Attributes:</b><br><hr style='margin: 5px 0;'>";
      for (const key in feature.properties) {
          const value = feature.properties[key];
          if(value !== null && key !== "GlobalID" && key !== "Shape__Length" && key !== "OBJECTID") {
             popupContent += `<b>${key}:</b> ${value}<br>`;
          }
      }
      popupContent += `<br><a href="${googleMapsUrl}" target="_blank" style="background:green; color:white; padding:5px; display:block; text-align:center; text-decoration:none;">Navigate Here</a>`;
      layer.bindPopup(popupContent).openPopup();
    });
  }
});

// Breadcrumb Layer (History = Blue Dots)
const breadcrumbLayer = L.esri.featureLayer({
    url: breadcrumbLayerUrl,
    pointToLayer: function (geojson, latlng) {
        return L.circleMarker(latlng, { color: 'blue', radius: 4, fillOpacity: 0.5 });
    }
});

// --- SMART DROPDOWNS ---
routeLayer.query().where("1=1").run(function(error, featureCollection){
    if (error) { console.error(error); return; }

    featureCollection.features.forEach(f => {
        allRouteData.push({
            operator: f.properties.Operator,
            truck: f.properties.Truck_Num
        });
    });
    updateDropdowns(null);
});

function updateDropdowns(changedBy) {
    const opSelect = document.getElementById("operatorInput");
    const truckSelect = document.getElementById("truckInput");
    const selectedOp = opSelect.value;
    const selectedTruck = truckSelect.value;

    let filteredData = allRouteData.filter(item => {
        let matchOp = (selectedOp === "") || (item.operator === selectedOp);
        let matchTruck = (selectedTruck === "") || (item.truck == selectedTruck); 
        return matchOp && matchTruck;
    });

    if (filteredData.length === 0) filteredData = allRouteData;

    const availableOps = new Set(filteredData.map(i => i.operator).filter(x => x));
    const availableTrucks = new Set(filteredData.map(i => i.truck).filter(x => x));

    if (changedBy !== "operator") {
        opSelect.innerHTML = '<option value="">-- Select Name --</option>';
        Array.from(availableOps).sort().forEach(name => {
            let opt = document.createElement("option");
            opt.value = name; opt.innerText = name;
            if (name === selectedOp) opt.selected = true; 
            opSelect.appendChild(opt);
        });
    }

    if (changedBy !== "truck") {
        truckSelect.innerHTML = '<option value="">-- Select Truck --</option>';
        Array.from(availableTrucks).sort((a,b)=>a-b).forEach(num => {
            let opt = document.createElement("option");
            opt.value = num; opt.innerText = "Truck " + num;
            if (num == selectedTruck) opt.selected = true; 
            truckSelect.appendChild(opt);
        });
    }
}

document.getElementById("operatorInput").addEventListener("change", () => updateDropdowns("operator"));
document.getElementById("truckInput").addEventListener("change", () => updateDropdowns("truck"));


// --- MAIN START FUNCTION ---
function startShift() {
  currentOperator = document.getElementById('operatorInput').value;
  currentTruck = document.getElementById('truckInput').value;

  if(!currentOperator && !currentTruck) {
    alert("Please select an Operator Name OR a Truck Number.");
    return;
  }

  document.getElementById('panel').style.display = 'none';
  
  // Update Label
  const label = document.getElementById('activeOperatorLabel');
  label.style.display = 'block';
  let labelText = "Viewing Route";
  if(currentOperator) labelText += ` for: ${currentOperator}`;
  if(currentTruck) labelText += ` — Truck ${currentTruck}`;
  label.innerText = labelText;

  // Filter Logic
  let sqlParts = [];
  if (currentOperator) sqlParts.push(`Operator = '${currentOperator}'`);
  if (currentTruck) sqlParts.push(`Truck_Num = ${currentTruck}`);
  const finalWhere = sqlParts.join(" OR ");
  
  routeLayer.setWhere(finalWhere);
  routeLayer.addTo(map);
  routeLayer.query().where(finalWhere).bounds(function(error, latLngBounds){
    if(!error && latLngBounds) map.fitBounds(latLngBounds);
  });

  loadTodaysBreadcrumbs();
  startTracking();
}

function loadTodaysBreadcrumbs() {
    const yesterday = new Date();
    yesterday.setHours(yesterday.getHours() - 24);
    
    let whereClause = `Timestamp > ${yesterday.getTime()}`;
    if (currentTruck) whereClause += ` AND Truck_Num = ${currentTruck}`;
    
    breadcrumbLayer.setWhere(whereClause);
    breadcrumbLayer.addTo(map);
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
    // Current location is GREEN
    window.myLocationMarker = L.circleMarker([lat, lng], { color: '#00FF00', radius: 10, fillOpacity: 1 }).addTo(map); 
  } else {
    window.myLocationMarker.setLatLng([lat, lng]);
  }

  const feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: {
      Truck_Num: parseInt(currentTruck) || 0,
      Operator: currentOperator,
      Timestamp: new Date().getTime()
    }
  };

  L.esri.request(breadcrumbLayerUrl + "/addFeatures", { features: [feature] }, function(error, response){});
}

function error() { console.log("GPS Error"); }

// --- CUSTOM MAP BUTTONS (Top Left Stack) ---

// 1. Home Button
L.Control.Home = L.Control.extend({
    onAdd: function(map) {
        const btn = L.DomUtil.create('div', 'custom-map-btn');
        btn.innerHTML = "🏠";
        btn.title = "Reset / Logout";
        btn.onclick = function() { location.reload(); }; 
        return btn;
    }
});
new L.Control.Home({ position: 'topleft' }).addTo(map);

// 2. Locate Button
L.Control.Locate = L.Control.extend({
    onAdd: function(map) {
        const btn = L.DomUtil.create('div', 'custom-map-btn');
        btn.innerHTML = "🎯";
        btn.title = "Find Me";
        btn.onclick = function() {
            if(lastKnownLocation) map.setView(lastKnownLocation, 17);
            else alert("Waiting for GPS...");
        };
        return btn;
    }
});
new L.Control.Locate({ position: 'topleft' }).addTo(map);

// 3. Legend Button (Restored!)
L.Control.Legend = L.Control.extend({
    onAdd: function(map) {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        
        // The Button
        const btn = L.DomUtil.create('a', 'custom-map-btn', container);
        btn.innerHTML = "📝"; // Notepad icon
        btn.title = "Show Legend";
        btn.href = "#";
        btn.style.width = "30px"; 
        btn.style.height = "30px";
        btn.style.lineHeight = "30px";
        btn.style.display = "block";
        btn.style.textAlign = "center";
        btn.style.textDecoration = "none";
        btn.style.backgroundColor = "white";
        btn.style.fontSize = "18px";

        // The Legend Box (Hidden by default)
        const legendBox = L.DomUtil.create('div', '', container);
        legendBox.style.display = 'none';
        legendBox.style.backgroundColor = 'white';
        legendBox.style.padding = '10px';
        legendBox.style.minWidth = '150px';
        legendBox.style.position = 'absolute';
        legendBox.style.top = '0px';
        legendBox.style.left = '35px'; // Appears to the right of the button
        legendBox.style.border = '2px solid rgba(0,0,0,0.2)';
        legendBox.style.borderRadius = '4px';

        // Legend Content
        legendBox.innerHTML = `
            <strong>Map Legend</strong><br><br>
            <div style="display:flex; align-items:center; margin-bottom:5px;">
                <div style="width:20px; height:4px; background:red; margin-right:8px;"></div>
                <span>Routes</span>
            </div>
            <div style="display:flex; align-items:center; margin-bottom:5px;">
                <div style="width:10px; height:10px; background:#00FF00; border-radius:50%; margin-right:8px;"></div>
                <span>My Live Location</span>
            </div>
            <div style="display:flex; align-items:center;">
                <div style="width:10px; height:10px; background:blue; border-radius:50%; margin-right:8px;"></div>
                <span>History (Work Done)</span>
            </div>
        `;

        // Toggle visibility on click
        btn.onclick = function(e) {
            e.preventDefault();
            if (legendBox.style.display === 'none') {
                legendBox.style.display = 'block';
            } else {
                legendBox.style.display = 'none';
            }
        };

        return container;
    }
});
new L.Control.Legend({ position: 'topleft' }).addTo(map);
