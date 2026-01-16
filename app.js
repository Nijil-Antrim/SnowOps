// 1. CONFIGURATION
// Note: No API Key needed!
const routeLayerUrl = "https://services9.arcgis.com/t2uVlIEulJrk7ioC/arcgis/rest/services/Snow_Plowing_Routes_2026_WFL1/FeatureServer/0"; 
const breadcrumbLayerUrl = "https://services9.arcgis.com/t2uVlIEulJrk7ioC/arcgis/rest/services/Snowplow_Breadcrumbs/FeatureServer/0"; 

// Initialize Map
const map = L.map('map', { zoomControl: false }).setView([39.7732, -77.7242], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
}).addTo(map);

// Add Controls
L.control.zoom({ position: 'topleft' }).addTo(map);
L.control.scale({ position: 'bottomleft', imperial: true, metric: false }).addTo(map);

// --- GLOBAL VARIABLES ---
let allRouteData = []; // Stores the raw data for filtering
let currentOperator = "";
let currentTruck = "";
let watchId = null;
let lastKnownLocation = null;

// --- LAYERS ---
const routeLayer = L.esri.featureLayer({
  url: routeLayerUrl,
  style: { color: 'red', weight: 4 },
  onEachFeature: function(feature, layer) {
    layer.on('click', function(e) {
      const lat = e.latlng.lat;
      const lng = e.latlng.lng;
      const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
      
      let popupContent = "<b>Route Attributes:</b><br><hr style='margin: 5px 0;'>";
      for (const key in feature.properties) {
          const value = feature.properties[key];
          // Filter out technical fields
          if(value !== null && key !== "GlobalID" && key !== "Shape__Length" && key !== "OBJECTID") {
             popupContent += `<b>${key}:</b> ${value}<br>`;
          }
      }
      popupContent += `<br><a href="${googleMapsUrl}" target="_blank" style="background:green; color:white; padding:5px; display:block; text-align:center; text-decoration:none;">Navigate Here</a>`;
      layer.bindPopup(popupContent).openPopup();
    });
  }
});

// Breadcrumb Layer (For history display)
const breadcrumbLayer = L.esri.featureLayer({
    url: breadcrumbLayerUrl,
    pointToLayer: function (geojson, latlng) {
        return L.circleMarker(latlng, { color: 'blue', radius: 4, fillOpacity: 0.5 });
    }
});

// --- SMART DROPDOWN LOGIC ---
// 1. Fetch all data ONCE when app loads
routeLayer.query().where("1=1").run(function(error, featureCollection){
    if (error) { console.error(error); return; }

    // Save data to global variable
    featureCollection.features.forEach(f => {
        allRouteData.push({
            operator: f.properties.Operator, // Ensure this matches your field name exactly
            truck: f.properties.Truck_Num    // Ensure this matches your field name exactly
        });
    });

    // Initial Populate
    updateDropdowns(null);
});

// 2. Function to filter and update lists
function updateDropdowns(changedBy) {
    const opSelect = document.getElementById("operatorInput");
    const truckSelect = document.getElementById("truckInput");

    // Get current selections
    const selectedOp = opSelect.value;
    const selectedTruck = truckSelect.value;

    // Filter the data based on selection
    let filteredData = allRouteData.filter(item => {
        let matchOp = (selectedOp === "") || (item.operator === selectedOp);
        let matchTruck = (selectedTruck === "") || (item.truck == selectedTruck); // use == for loose comparison (string vs number)
        return matchOp && matchTruck;
    });

    // If nothing matches (edge case), reset to full list
    if (filteredData.length === 0) filteredData = allRouteData;

    // Extract unique values from the filtered list
    const availableOps = new Set(filteredData.map(i => i.operator).filter(x => x));
    const availableTrucks = new Set(filteredData.map(i => i.truck).filter(x => x));

    // REBUILD OPERATOR DROPDOWN (If user didn't just change it)
    if (changedBy !== "operator") {
        opSelect.innerHTML = '<option value="">-- Select Name --</option>';
        Array.from(availableOps).sort().forEach(name => {
            let opt = document.createElement("option");
            opt.value = name;
            opt.innerText = name;
            if (name === selectedOp) opt.selected = true; // Keep selection
            opSelect.appendChild(opt);
        });
    }

    // REBUILD TRUCK DROPDOWN (If user didn't just change it)
    if (changedBy !== "truck") {
        truckSelect.innerHTML = '<option value="">-- Select Truck --</option>';
        Array.from(availableTrucks).sort((a,b)=>a-b).forEach(num => {
            let opt = document.createElement("option");
            opt.value = num;
            opt.innerText = "Truck " + num;
            if (num == selectedTruck) opt.selected = true; // Keep selection
            truckSelect.appendChild(opt);
        });
    }
}

// Add Event Listeners to trigger the filter
document.getElementById("operatorInput").addEventListener("change", () => updateDropdowns("operator"));
document.getElementById("truckInput").addEventListener("change", () => updateDropdowns("truck"));


// --- MAIN LOGIC ---
function startShift() {
  currentOperator = document.getElementById('operatorInput').value;
  currentTruck = document.getElementById('truckInput').value;

  if(!currentOperator && !currentTruck) {
    alert("Please select an Operator Name OR a Truck Number.");
    return;
  }

  // Hide Login
  document.getElementById('panel').style.display = 'none';
  
  // 1. UPDATE LABEL (The "This is John Doe map" request)
  const label = document.getElementById('activeOperatorLabel');
  label.style.display = 'block';
  
  let labelText = "Viewing Route";
  if(currentOperator) labelText += ` for: ${currentOperator}`;
  if(currentTruck) labelText += ` — Truck ${currentTruck}`;
  
  label.innerText = labelText;

  // 2. FILTER MAP
  let sqlParts = [];
  if (currentOperator) sqlParts.push(`Operator = '${currentOperator}'`);
  if (currentTruck) sqlParts.push(`Truck_Num = ${currentTruck}`);
  const finalWhere = sqlParts.join(" OR ");
  
  routeLayer.setWhere(finalWhere);
  routeLayer.addTo(map);
  routeLayer.query().where(finalWhere).bounds(function(error, latLngBounds){
    if(!error && latLngBounds) map.fitBounds(latLngBounds);
  });

  // 3. LOAD HISTORY (The "80% Done" request)
  loadTodaysBreadcrumbs();

  // 4. START TRACKING
  startTracking();
}

function loadTodaysBreadcrumbs() {
    // Calculate timestamp for 24 hours ago
    const yesterday = new Date();
    yesterday.setHours(yesterday.getHours() - 24);
    
    // Query breadcrumbs for this truck/operator created recently
    let whereClause = `Timestamp > ${yesterday.getTime()}`;
    if (currentTruck) whereClause += ` AND Truck_Num = ${currentTruck}`;
    
    // Add them to the map permanently for this session
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
    window.myLocationMarker = L.circleMarker([lat, lng], { color: '#00FF00', radius: 10, fillOpacity: 1 }).addTo(map); // Bright Green for "ME"
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
      Timestamp: new Date().getTime()
    }
  };

  L.esri.request(breadcrumbLayerUrl + "/addFeatures", { features: [feature] }, function(error, response){});
}

function error() { console.log("GPS Error"); }

// Map Buttons (Home, Locate)
L.Control.Home = L.Control.extend({
    onAdd: function(map) {
        const btn = L.DomUtil.create('div', 'custom-map-btn');
        btn.innerHTML = "🏠";
        btn.onclick = function() { location.reload(); }; // Reload page to reset
        return btn;
    }
});
new L.Control.Home({ position: 'topleft' }).addTo(map);

L.Control.Locate = L.Control.extend({
    onAdd: function(map) {
        const btn = L.DomUtil.create('div', 'custom-map-btn');
        btn.innerHTML = "🎯";
        btn.onclick = function() {
            if(lastKnownLocation) map.setView(lastKnownLocation, 17);
        };
        return btn;
    }
});
new L.Control.Locate({ position: 'topleft' }).addTo(map);
