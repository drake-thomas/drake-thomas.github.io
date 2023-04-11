//Print a random line from the file at links.txt
function addRandomLink() {
    var linkContainer = document.getElementById("random-link-container");

    fetch("map_links.txt")
        .then(response => response.text())
        .then(text => {
            var lines = text.split("\n");
            for (var i = 0; i < 5; i++) {
                var randomIndex = Math.floor(Math.random() * lines.length);
                var randomLink = lines[randomIndex];
                linkContainer.innerHTML += "<a href='" + randomLink + "'>" + "Obscured link #" + (i+1) + "</a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;";
            }
            
        });
}