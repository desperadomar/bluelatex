/* DEBUG */
var pdfDimension = null;
var createBlock = function (b, page){
  var previews = preview.getElementsByClassName('preview_page_container');
  var block = document.createElement('div');
  if(pdfDimension==null) {
    var img = previews[page-1].getElementsByTagName('img')[0];
    pdfDimension = {
      scale: img.height/(img.naturalHeight*0.72),
      height: img.height
    };
  }
  var s1 = convertToViewportPoint(b.left, b.bottom, pdfDimension);
  var s2 = convertToViewportPoint(b.width, b.height, pdfDimension);

  block.style.top = pdfDimension.height-s1[1]-(pdfDimension.height-s2[1]) + 'px';
  block.style.left = s1[0]+ 'px';
  block.style.width =  s2[0] + 'px';
  block.style.height = (pdfDimension.height-s2[1])+'px';
  block.classList.add(b.type);
  block.classList.add('debug_block');

  var info = document.createElement('div');
  info.classList.add('info');
  info.innerHTML = '<span class="file">'+b.fileNumber+'</span><span class="line">'+b.line+'</span>';
  block.appendChild(info);

  previews[page-1].appendChild(block);
};

var createElem = function (elm ,page){
  //if(elm.type!='x') return;
  var previews = preview.getElementsByClassName('preview_page_container');
  var block = document.createElement('div');

  if(pdfDimension==null) {
    var img = previews[page-1].getElementsByTagName('img')[0];
    pdfDimension = {
      scale: img.height/(img.naturalHeight*0.72),
      height: img.height
    };
  }

  var s1 = convertToViewportPoint(elm.left, elm.bottom, pdfDimension);
  var s2 = convertToViewportPoint(elm.width, elm.height, pdfDimension);

  block.style.top = pdfDimension.height-s1[1]-(pdfDimension.height-s2[1]) + 'px';
  block.style.left = s1[0]+ 'px';
  block.style.width =  '1px';
  block.style.height = (pdfDimension.height-s2[1])+'px';
  block.classList.add('debug_block');
  block.classList.add(elm.type);

  var info = document.createElement('div');
  info.classList.add('info');
  info.innerHTML = '<span class="file">'+elm.fileNumber+'</span><span class="line">'+elm.line+'</span>';
  block.appendChild(info);
  previews[page-1].appendChild(block);
};

var removeBlocks = function () {
  var blocks = preview.getElementsByClassName('debug_block');
  for (var i = blocks.length - 1; i >= 0; i--) {
    var block = blocks[i];
    block.parentNode.removeChild(block);
  }
};

var displayBlocks = function (blocks, page) {
  if(!isArray(blocks)) return;
  for (var j = blocks.length - 1; j >= 0; j--) {
    var block = blocks[j];
    //if(block.type!='v block')continue;
    createBlock(block,page);
    displayBlocks(block.blocks,page);
    for (var i = block.elements.length - 1; i >= 0; i--) {
      var elm = block.elements[i];
      createElem(elm,page);
    }
  }
};

var displayPages = function (pages) {
  removeBlocks();
  for(var i in pages) {
    var page = pages[i];
    displayBlocks(page.blocks,i);
  }
};

angular.module('bluelatex.Paper.Controllers.Paper', ['angularFileUpload','bluelatex.Paper.Directives.Toc','bluelatex.Paper.Services.Ace','bluelatex.Paper.Services.Paper','bluelatex.Paper.Services.Ace','bluelatex.Latex.Services.SyncTexParser'])
  .controller('PaperController', ['$rootScope','$scope', 'localize', '$location', 'AceService', 'PaperService', '$routeParams', '$upload', '$log','MessagesService','SyncTexParserService','$document',
    function ($rootScope,$scope, localize, $location, AceService, PaperService, $routeParams, $upload, $log,MessagesService,SyncTexParserService,$document) {
      var paper_id = $routeParams.id;

      $scope.paperId = paper_id;
      $scope.pageViewport = {};

      $scope.currentLine = 0;
      $scope.currentPage = 0;

      $scope.resources = [];
      $scope.paper = {};
      $scope.listType = 'files';
      $scope.mode = 'ace';
      $scope.logs = [];
      $scope.toc = [];
      $scope.content = '';
      $scope.new_file = {};
      $scope.synctex = null;
      $scope.zipURL = PaperService.getZipUrl(paper_id);
      $scope.pdfURL = PaperService.getPDFUrl(paper_id);
      $scope.logURL = PaperService.getLogUrl(paper_id);
      $scope.currentFile = {};

      $scope.vignetteType = "pdf";
      $scope.urlPaper = PaperService.getPaperUrlRoot(paper_id);
      $scope.scale = "auto";
      $scope.totalPage = 0;

      $scope.revision=Math.random();

      /**
      * Download and parse SyncTex file
      */
      var getSyncTex = function () {
        PaperService.getSynctex(paper_id).then(function (data) {
          $scope.synctex = SyncTexParserService.parse(data);
          $scope.$apply(function () {
            $scope.synctex = $scope.synctex;
          });
        });
      };

      /**
      * Exit paper
      */
      var exitPaper = function () {
        if($scope.paper.authors &&
           $scope.paper.authors.indexOf($rootScope.loggedUser.name) >= 0) {
          stopMobWrite();
          PaperService.leavePaper(paper_id).then(function (data) {
            console.log("paper leaved");
          });
        }
      };

      window.onbeforeunload = function (event) {
        exitPaper();
      };

      /**
      * Start mobWrite
      */
      var initMobWrite = function () {
        mobwrite.syncUsername = $rootScope.loggedUser.name;
        mobwrite.share({paper_id: $scope.paperId,file:$scope.currentFile.title});
      };

      /**
      * Stop sharing file
      */
      var stopMobWrite = function () {
        if(mobwrite) {
          mobwrite.unload_();
          mobwrite.unshare({paper_id: $scope.paperId,file:$scope.currentFile.title});
        }
      };

      /**
      * Get the number of page of the paper
      */
      var getPages = function () {
        PaperService.getPages(paper_id).then(function (data) {
          $scope.totalPage = data.response;
          if($scope.currentPage == 0)
            $scope.currentPage = 1;
        });
      };

      /*
      * Download the log file
      */
      var getLog = function () {
        PaperService.getLog(paper_id).then(function (data) {
          var logs = LatexParser.parse(data,{});
          var annotations = [];
          for (var i = 0; i < logs.all.length; i++) {
            var error = logs.all[i];
            annotations.push({
              row: error.line - 1,
              column: 1,
              text: error.message,
              type: (error.level=="error")?"error":'warning' // also warning and information
            });
          }
          AceService.getSession().setAnnotations(annotations);
        });
      };

      /**
      * Get the list of synchronised file
      */
      var getSynchronizedFiles = function (callback) {
        PaperService.getSynchronized(paper_id).then(function (data) {
          $scope.synchronizedFiles = data;
          for (var i = 0; i < $scope.synchronizedFiles.length; i++) {
            if($scope.synchronizedFiles[i].title == $scope.paperId + ".tex") {
              $scope.currentFile = $scope.synchronizedFiles[i];
              break;
            }
          }
          if(callback) callback();
        }, function (error) {
          MessagesService.clear();
          switch (err.status) {
          case 400:
            MessagesService.error('_Delete_resource_Some_parameters_are_missing_',err);
            break;
          case 401:
            MessagesService.error('_Delete_resource_Wrong_username_and_or_password_',err);
            break;
          case 500:
            MessagesService.error('_Delete_resource_Something_wrong_happened_',err);
            break;
          default:
            MessagesService.error('_Delete_resource_Something_wrong_happened_',err);
          }
        });
      };

      /**
      * Download Tex file
      */
      var getTexfile = function (callback) {
        var file_name = PaperService.getResourceUrl(paper_id,paper_id+".tex");
        PaperService.downloadRessource(file_name).then(function (data) {
          $scope.content = data;
          getLog();
          if(callback) {
            callback();
          }
        }, function (error) {
          // body...
        });
      };

      /**
      * Update Tex file
      */
      var updateTexfile = function () {
        var file_name = PaperService.getResourceUrl(paper_id+".tex");
        PaperService.uploadResource(paper_id,paper_id+".tex", $scope.content).then(function (data) {

        }, function (error) {

        });
      };

      /**
      * Get the list of resources
      */
      var getResources = function () {
        PaperService.getResources(paper_id).then(function (data) {
          $scope.resources = data;
        }, function (error) {
          MessagesService.clear();
          switch (err.status) {
          case 400:
            MessagesService.error('_Delete_resource_Some_parameters_are_missing_',err);
            break;
          case 401:
            MessagesService.error('_Delete_resource_Wrong_username_and_or_password_',err);
            break;
          case 500:
            MessagesService.error('_Delete_resource_Something_wrong_happened_',err);
            break;
          default:
            MessagesService.error('_Delete_resource_Something_wrong_happened_',err);
          }
        });
      };

      /**
      * Close connection on leaving
      */
      $scope.$on('$locationChangeStart', function (event, next, current) {
        exitPaper();
      });

      /**
      * The the paper infos
      */
      var updateTexInterval = 0;
      var getPaperInfo = function () {
        PaperService.getInfo(paper_id).then(function (data) {
          getPages();
          $scope.paper = data;
          $scope.paper.etag = data.header.etag;
          if($scope.paper.authors.indexOf($rootScope.loggedUser.name) >= 0) {
            PaperService.joinPaper(paper_id).then(function (data) {
              getSynchronizedFiles(function () {
                initMobWrite();
              });
            });
            getResources();
            getSyncTex();
          }
        }, function (error) {
          MessagesService.clear();
          switch (err.status) {
          case 400:
            MessagesService.error('_Delete_resource_Some_parameters_are_missing_',err);
            break;
          case 401:
            MessagesService.error('_Delete_resource_Wrong_username_and_or_password_',err);
            break;
          case 500:
            MessagesService.error('_Delete_resource_Something_wrong_happened_',err);
            break;
          default:
            MessagesService.error('_Delete_resource_Something_wrong_happened_',err);
          }
        });
      };
      getPaperInfo();

      $scope.$watch('displaySyncTexBox', function (value) {
        if(value)
          displayPages($scope.synctex.pages);
        else
          removeBlocks();
      });

      //action listener: action in the menu
      $scope.$on('handleAction', function (event, data) {
        if ($scope[data]) {
          $scope[data]();
        }
      });

      $scope.changeFile = function (file) {
        if($scope.currentFile == file) return;
        stopMobWrite();
        $scope.currentFile = file;
        $scope.content = '';
        AceService.setContent($scope.content);
        initMobWrite();
      };

      $scope.changeFileFromName = function(filename) {
        if($scope.currentFile.title == filename) return;
        for (var i = $scope.synchronizedFiles.length - 1; i >= 0; i--) {
          var syncFile = $scope.synchronizedFiles[i];
          if(syncFile.title == filename) {
            $scope.changeFile(syncFile);
          }
        }
      };

      /**
      * Compile the paper
      */
      $scope.compile = function () {
        PaperService.subscribePaperCompiler(paper_id).then(function (data) {
          getLog();
          getSyncTex();
          getPages();
          $scope.revision++;
        }, function (error) {
          getLog();
          getSyncTex();
          $scope.revision++;
        });
      };
      /**
      * Go to the next page
      */
      $scope.nextPage = function () {
        $scope.changePage($scope.currentPage+1);
      };
      /**
      * Go to the previous page
      */
      $scope.prevPage = function () {
        $scope.changePage($scope.currentPage-1);
      };
      /**
      * Go to the page: page
      */
      $scope.changePage = function (page) {
        if(page > 0 && page <=$scope.totalPage ) {
          $scope.currentPage = page;

          for(var i in $scope.synctex.blockNumberLine) {
            if($scope.synctex.blockNumberLine[i][0].page == page) {
              $scope.goToLine(i);
              return;
            }
          }
        }
      };
      /**
      * Go to the line: line
      */
      $scope.goToLine = function (line) {
        AceService.goToLine(line);
        $scope.currentLine = line;
      };

      $scope.itsalltextClass = (document.querySelector(".centerCol .itsalltext") && document.querySelector(".centerCol .itsalltext").id)?'':'hidden';
      var itsalltext_inited = false;
      var init_itsalltext = function () {
        if(itsalltext_inited) return;
        var area = $document[0].querySelector(".itsalltext");
        if (area.addEventListener) {
          area.addEventListener('change', function() {
            $scope.content = this.value;
            AceService.setContent($scope.content);
            AceService.getEditor().focus();
          }, false);
        } else if (area.attachEvent) {
          area.attachEvent('onpropertychange', function() {
            $scope.content = this.value;
            AceService.setContent($scope.content);
            AceService.getEditor().focus();
          });
        }
        itsalltext_inited = true;
      };

      $scope.$watch("content", function (value) {
        if(value && itsalltext_inited){
          $document[0].querySelector(".itsalltext").value = value;
          $scope.openItsalltext();
        }
      });

      $scope.openItsalltext = function () {
        if($document[0].querySelector(".itsalltext + img")){
          init_itsalltext();
          $document[0].querySelector(".itsalltext + img").click();
        }else
          MessagesService.warning("Install It's All Text");
      };
      /**
      * Load ACE editor
      */
      $scope.aceLoaded = function (_editor) {
        AceService.aceLoaded(_editor, function () {
          _editor.selection.on("changeCursor", function(){
            $scope.$apply(function() {
              $scope.currentLine = _editor.selection.getCursor().row+1;
              if(!$scope.synctex) return;
              if(!$scope.synctex.blockNumberLine[$scope.currentLine]) return;
              $scope.currentPage = $scope.synctex.blockNumberLine[$scope.currentLine][0].page;
            });
          });
          setTimeout(function () {
            $scope.itsalltextClass = (document.querySelector(".centerCol .itsalltext") && document.querySelector(".centerCol .itsalltext").id)?'':'hidden';
            $scope.$apply();
          },1500);
          $scope.toc = AceService.getToc();
          AceService.getSession().on("change", function () {
            $scope.toc = AceService.getToc();
          });
          _editor.focus();
        });
      };

      $scope.aceChanged = function (e) {};

      /**
      * User selects a file to upload
      */
      $scope.onFileSelect = function ($files) {
        if ($files.length > 0) {
          var file = $files[0];
          $scope.new_file = {
            title: file.name,
            name: file.name.replace(/\.[^\.]+$/, ''),
            type: getFileType(file.name),
            file: file,
            extension: getFileNameExtension(file.name)
          };
        }
      };

      /**
      * Upload a resource
      */
      $scope.uploadResource = function () {
        PaperService.uploadResource(paper_id, $scope.new_file.title, $scope.new_file.file).then(function (data) {
          if(data.data == true) {
            getResources();
            $scope.new_file = {};
          } else
            MessagesService.error('_Upload_resource_Some_parameters_are_missing_');
        }, function (err) {
          MessagesService.clear();
          switch (err.status) {
          case 400:
            MessagesService.error('_Upload_resource_Some_parameters_are_missing_',err);
            break;
          case 401:
            MessagesService.error('_Upload_resource_Wrong_username_and_or_password_',err);
            break;
          case 500:
            MessagesService.error('_Upload_resource_Something_wrong_happened_',err);
            break;
          default:
            MessagesService.error('_Upload_resource_Something_wrong_happened_',err);
          }
        }, function (progress) {
          $log.debug(progress);
        });
      };

      /**
      * Cancel an upload
      */
      $scope.cancelUploadResource = function () {
        $scope.new_file = {};
      };
      /**
      * View a resource
      */
      $scope.viewResource = function (resource) {

      };
      /**
      * Remove a resource
      */
      $scope.removeResource = function (resource) {
        PaperService.removeResource(paper_id, resource.title).then(function (data) {
          if(data.response == true) {
            getResources();
            $scope.new_file = {};
          } else
            MessagesService.error('_Delete_resource_Some_parameters_are_missing_');
        }, function (err) {
          MessagesService.clear();
          switch (err.status) {
          case 400:
            MessagesService.error('_Delete_resource_Some_parameters_are_missing_',err);
            break;
          case 401:
            MessagesService.error('_Delete_resource_Wrong_username_and_or_password_',err);
            break;
          case 500:
            MessagesService.error('_Delete_resource_Something_wrong_happened_',err);
            break;
          default:
            MessagesService.error('_Delete_resource_Something_wrong_happened_',err);
          }
        });
      };

      /*
      * Download a resource
      */
      $scope.downloadResource = function (resource) {
        window.open(PaperService.getResourceUrl(paper_id, resource.title));
      };

      $scope.downloadLog = function () {
        window.open($scope.logURL);
      };
      $scope.downloadPDF = function () {
        window.open($scope.pdfURL);
      };
      $scope.downloadZip = function () {
        window.open($scope.zipURL);
      };

      $scope.range = function(n) {
        return new Array(parseInt(n));
      };
    }
  ]);